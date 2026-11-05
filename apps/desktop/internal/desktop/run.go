// Package desktop owns the MyGo webview and desktop lifecycle, never UI data.
package desktop

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

var instanceOnce sync.Once
var primaryInstance bool

// GenerateBindings lets the MyGo CLI inspect the shell without opening storage,
// listeners, a single-instance lock or the platform event loop.
func GenerateBindings() error {
	if os.Getenv("MYGO_GENERATE") == "" {
		return errors.New("binding generation requires MYGO_GENERATE")
	}
	mygo.Bind(&Shell{})
	return mygo.App.Run()
}

// AcquireInstance must precede listening. A second launch forwards its arguments.
func AcquireInstance() bool {
	instanceOnce.Do(func() {
		mygo.App.SetName("Tool Logger")
		primaryInstance = mygo.App.RequestSingleInstanceLock()
	})
	return primaryInstance
}

// Run owns the main-thread window lifetime. The caller owns both HTTP servers
// and SQLite, closing them after Run returns. Cancellation requests application Quit.
func Run(ctx context.Context, origin, state string, issueSession func() *http.Cookie) error {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("desktop requires an HTTP UI origin")
	}
	if !AcquireInstance() {
		return nil
	}
	app := mygo.App
	app.SetPath(mygo.PathUserData, filepath.Join(state, "webview"))
	mygo.Bind(&Shell{state: state, quit: app.Quit})
	var win *mygo.Window
	var startupErr error
	var quitting, documentReady bool
	var pending []pageEvent
	show := func() {
		if win != nil && !quitting {
			win.Show()
			win.Focus()
		}
	}
	deliver := func() {
		if win == nil || !documentReady || len(pending) == 0 || quitting {
			return
		}
		events := pending
		pending = nil
		// Eval pumps the main loop while awaiting the page; remove the batch
		// before calling it so reentrant callbacks cannot deliver it twice.
		evalCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if _, err := win.Page().EvalContext(evalCtx, eventScript(events)); err != nil && ctx.Err() == nil {
			log.Printf("desktop command: %v", err)
		}
	}
	enqueue := func(event pageEvent) {
		if len(pending) == 64 {
			pending = pending[1:]
		}
		pending = append(pending, event)
		deliver()
	}
	command := func(name string) func(*mygo.MenuItem, *mygo.Window) {
		return func(*mygo.MenuItem, *mygo.Window) {
			event, err := commandEvent(name)
			if err == nil {
				show()
				enqueue(event)
			}
		}
	}
	app.OnBeforeQuit(func(*mygo.QuitEvent) { quitting = true })
	app.OnWindowAllClosed(func() {})
	app.OnActivate(func(bool) { show() })
	// MyGo delivers registered URL arguments to OnOpenURL for both the first
	// launch and second-instance forwards. Handling them here too duplicates links.
	app.OnSecondInstance(func([]string, string) { show() })
	app.OnOpenURL(func(raw string) {
		event, err := linkEvent(raw)
		if err != nil {
			log.Printf("desktop deep link: %v", err)
			return
		}
		enqueue(event)
		show()
	})
	if err := app.RegisterURLScheme("tool-logger"); err != nil {
		log.Printf("tool-logger URL registration: %v", err)
	}
	app.WhenReady(func() {
		if ctx.Err() != nil {
			app.Quit()
			return
		}
		cookie := issueSession()
		if cookie == nil || !cookie.HttpOnly {
			startupErr = errors.New("desktop session issuance failed")
			app.Quit()
			return
		}
		sameSite := mygo.CookieSameSiteStrict
		if cookie.SameSite == http.SameSiteLaxMode {
			sameSite = mygo.CookieSameSiteLax
		}
		if err := mygo.Cookies.Set(mygo.Cookie{Name: cookie.Name, Value: cookie.Value, Domain: u.Hostname(), Path: cookie.Path, Expires: cookie.Expires, Secure: cookie.Secure, HTTPOnly: true, SameSite: sameSite}); err != nil {
			startupErr = err
			app.Quit()
			return
		}
		if quitting || ctx.Err() != nil {
			app.Quit()
			return
		}
		// Avoid MyGo's default frontend URL, which points directly at Vite in
		// development. Install navigation handlers before loading our HTTP origin.
		win = mygo.NewWindow(mygo.WindowOptions{Title: "Tool Logger", URL: "about:blank", Width: 1440, Height: 900, MinWidth: 960, MinHeight: 640, StateKey: "activity", Page: mygo.PageOptions{TrustedOrigins: []string{origin}}})
		win.OnClose(func(e *mygo.CloseEvent) {
			if !quitting {
				e.PreventDefault()
				win.Hide()
			}
		})
		page := win.Page()
		page.OnWillNavigate(func(e *mygo.NavigateEvent) {
			if sameOrigin(origin, e.URL) {
				return
			}
			e.PreventDefault()
			openExternal(e.URL)
		})
		page.SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
			openExternal(req.URL)
			return nil
		})
		page.OnDidNavigate(func(string) { documentReady = false })
		page.OnDOMReady(func() {
			if sameOrigin(origin, page.URL()) {
				documentReady = true
				deliver()
			}
		})
		app.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
			{Role: mygo.RoleAppMenu}, {Role: mygo.RoleEditMenu},
			{Label: "Activity", Submenu: []*mygo.MenuItem{
				{Label: "Open Tool Logger", Accelerator: "CmdOrCtrl+Shift+O", Click: func(*mygo.MenuItem, *mygo.Window) { show() }},
				{Label: "Close Window", Accelerator: "CmdOrCtrl+W", Click: func(*mygo.MenuItem, *mygo.Window) { win.Close() }},
				{Label: "Search calls", Accelerator: "CmdOrCtrl+F", Click: command("search")},
				{Label: "Back", Accelerator: "Alt+Left", Click: command("back")},
				{Label: "Forward", Accelerator: "Alt+Right", Click: command("forward")},
				{Label: "Pause / Resume", Accelerator: "CmdOrCtrl+Shift+P", Click: command("pause")},
				{Label: "Copy call JSON", Accelerator: "CmdOrCtrl+Shift+C", Click: command("copy-json")},
				{Label: "Copy activity link", Click: command("copy-link")},
				{Label: "Connection diagnostics", Click: command("diagnostics")},
				mygo.Separator(), {Role: mygo.RoleQuit, Label: "Quit"},
			}}, {Role: mygo.RoleWindowMenu},
		}))
		trayMenu := mygo.NewMenu([]*mygo.MenuItem{
			{Label: "Open Tool Logger", Click: func(*mygo.MenuItem, *mygo.Window) { show() }},
			mygo.Separator(), {Role: mygo.RoleQuit, Label: "Quit"},
		})
		tray, err := mygo.NewTray(mygo.TrayOptions{Icon: trayIcon(), IconIsTemplate: true, ToolTip: "Tool Logger", Menu: trayMenu})
		if err != nil {
			log.Printf("Tool Logger tray unavailable: %v; reopen through dock or launch again", err)
		} else {
			app.OnWillQuit(func(*mygo.QuitEvent) { tray.Destroy() })
		}
		if err := page.LoadURL(origin + "/"); err != nil {
			startupErr = err
			app.Quit()
		}
	})
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			app.Quit()
		case <-done:
		}
	}()
	return errors.Join(app.Run(), startupErr)
}

func openExternal(raw string) {
	if externalURL(raw) {
		go func() {
			if err := mygo.Shell.OpenExternal(raw); err != nil {
				log.Printf("open external link: %v", err)
			}
		}()
	}
}

func trayIcon() []byte {
	img := image.NewNRGBA(image.Rect(0, 0, 32, 32))
	for i, h := range []int{10, 22, 16} {
		draw.Draw(img, image.Rect(5+i*8, 28-h, 10+i*8, 28), image.NewUniform(color.NRGBA{R: 199, G: 231, B: 128, A: 255}), image.Point{}, draw.Src)
	}
	var data bytes.Buffer
	_ = png.Encode(&data, img)
	return data.Bytes()
}
