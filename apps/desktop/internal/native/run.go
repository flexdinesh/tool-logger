package native

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"path/filepath"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"tool-logger/desktop/internal/apiclient"
)

var instanceOnce sync.Once
var primaryInstance bool

// AcquireInstance should be called before opening the HTTP listener. A second
// process forwards its command line to the existing observer and returns false.
// Run calls it too, so embedders without a listener need only Run.
func AcquireInstance() bool {
	instanceOnce.Do(func() {
		mygo.App.SetName("Tool Logger")
		primaryInstance = mygo.App.RequestSingleInstanceLock()
	})
	return primaryInstance
}

// Run owns the main-thread native lifetime. endpoint is the already running
// HTTP server's base URL. Closing the window leaves ingestion running; Quit
// returns from Run so the caller can shut down its HTTP server.
func Run(endpoint, adminToken string) error {
	client, err := apiclient.New(endpoint, adminToken)
	if err != nil {
		return err
	}
	if !AcquireInstance() {
		return nil
	}
	path := preferencesPath()
	m := newModel(client, endpoint, loadPreferences(path))
	defer m.stop()
	m.persist = make(chan preferences, 1)
	persistDone := make(chan struct{})
	go func() {
		defer close(persistDone)
		for p := range m.persist {
			if err := writePreferences(path, p); err != nil {
				log.Printf("native preferences: %v", err)
			}
		}
	}()
	defer func() { close(m.persist); <-persistDone }()
	app := mygo.App
	app.SetPath(mygo.PathUserData, filepath.Join(filepath.Dir(path), "native"))
	var win *mygo.Window
	show := func() {
		if win != nil {
			win.Show()
			win.Focus()
		}
	}
	m.quit = app.Quit
	quitting := false
	app.OnBeforeQuit(func(*mygo.QuitEvent) { quitting = true; m.save(); m.stop() })
	app.OnWindowAllClosed(func() {})
	app.OnActivate(func(bool) { show() })
	app.OnSecondInstance(func([]string, string) { show() })
	app.OnOpenURL(func(raw string) {
		if err := m.openLink(raw); err != nil {
			m.activityError = err.Error()
		}
		show()
	})
	app.WhenReady(func() {
		win = mygo.NewWindow(mygo.WindowOptions{Title: "Tool Logger", Width: 1440, Height: 900, MinWidth: 960, MinHeight: 640, StateKey: "activity", Content: ui.View(m.view)})
		m.update = win.Update
		win.OnClose(func(e *mygo.CloseEvent) {
			if !quitting {
				e.PreventDefault()
				m.save()
				win.Hide()
			}
		})
		menu := mygo.NewMenu([]*mygo.MenuItem{
			{Role: mygo.RoleAppMenu},
			{Role: mygo.RoleEditMenu},
			{Label: "Activity", Submenu: []*mygo.MenuItem{
				{Label: "Open Tool Logger", Accelerator: "CmdOrCtrl+Shift+O", Click: func(*mygo.MenuItem, *mygo.Window) { show() }},
				{Label: "Close Window", Accelerator: "CmdOrCtrl+W", Click: func(*mygo.MenuItem, *mygo.Window) { win.Close() }},
				{Label: "Search calls", Accelerator: "CmdOrCtrl+F", Click: func(*mygo.MenuItem, *mygo.Window) { show(); m.search.Focus() }},
				{Label: "Back", Accelerator: "Alt+Left", Click: func(*mygo.MenuItem, *mygo.Window) { win.Update(func() { m.back(-1) }) }},
				{Label: "Forward", Accelerator: "Alt+Right", Click: func(*mygo.MenuItem, *mygo.Window) { win.Update(func() { m.back(1) }) }},
				{Label: "Pause / Resume", Accelerator: "CmdOrCtrl+Shift+P", Click: func(*mygo.MenuItem, *mygo.Window) { win.Update(m.pause) }},
				{Label: "Copy call JSON", Accelerator: "CmdOrCtrl+Shift+C", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.Clipboard.WriteText(m.payload()) }},
				{Label: "Copy activity link", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.Clipboard.WriteText(m.deepLink()) }},
				{Label: "Connection diagnostics", Click: func(*mygo.MenuItem, *mygo.Window) { show(); win.Update(func() { m.showSetup = true; m.diagnose() }) }},
				mygo.Separator(), {Role: mygo.RoleQuit, Label: "Quit"},
			}},
			{Role: mygo.RoleWindowMenu},
		})
		app.SetMenu(menu)
		trayMenu := mygo.NewMenu([]*mygo.MenuItem{
			{Label: "Open Tool Logger", Click: func(*mygo.MenuItem, *mygo.Window) { show() }},
			mygo.Separator(), {Role: mygo.RoleQuit, Label: "Quit"},
		})
		tray, trayErr := mygo.NewTray(mygo.TrayOptions{Icon: trayIcon(), IconIsTemplate: true, ToolTip: "Tool Logger", Menu: trayMenu})
		if trayErr != nil {
			log.Printf("Tool Logger tray unavailable: %v; reopen through dock or launch Tool Logger again", trayErr)
		} else {
			app.OnWillQuit(func(*mygo.QuitEvent) { tray.Destroy() })
		}
		if err := app.RegisterURLScheme("tool-logger"); err != nil {
			log.Printf("tool-logger URL registration: %v", err)
		}
		m.refresh(false)
		if m.prefs.Selected != "" {
			m.selectCall(m.prefs.Selected, true)
		}
		go func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-m.closed.Done():
					return
				case <-ticker.C:
					win.Update(func() {
						if !m.prefs.Paused {
							m.refresh(false)
						}
					})
				}
			}
		}()
	})
	return app.Run()
}

func trayIcon() []byte {
	img := image.NewNRGBA(image.Rect(0, 0, 32, 32))
	for i, h := range []int{10, 22, 16} {
		draw.Draw(img, image.Rect(5+i*8, 28-h, 10+i*8, 28), image.NewUniform(color.NRGBA{R: 199, G: 231, B: 128, A: 255}), image.Point{}, draw.Src)
	}
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}
