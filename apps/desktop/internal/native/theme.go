package native

import "github.com/egoist/mygo/ui"

// Graphite maps DESIGN.md's semantic roles to native widgets.
func graphite(dark bool) *ui.Theme {
	t := ui.LightTheme()
	if dark {
		t = ui.DarkTheme()
		t.Background = ui.Hex("#17191d")
		t.Surface = ui.Hex("#1b1f24")
		t.SurfaceHover = ui.Hex("#22272e")
		t.SurfacePressed = ui.Hex("#2d3727")
		t.Text = ui.Hex("#e9edf2")
		t.TextMuted = ui.Hex("#9ca6b3")
		t.Border = ui.Hex("#343b44")
		t.Accent = ui.Hex("#c7e780")
		t.AccentHover = ui.Hex("#d8efa5")
		t.AccentPressed = ui.Hex("#b4d668")
		t.AccentText = ui.Hex("#18210e")
		t.Warning = ui.Hex("#efbe6b")
		t.Danger = ui.Hex("#ff9c9c")
		t.Success = ui.Hex("#9bd58e")
		t.Selection = ui.Hex("#2d3727")
		t.Scrollbar = ui.Hex("#4d5865")
	} else {
		t.Background = ui.Hex("#f5f6f7")
		t.Surface = ui.Hex("#ffffff")
		t.SurfaceHover = ui.Hex("#eef1f3")
		t.SurfacePressed = ui.Hex("#edf4e1")
		t.Text = ui.Hex("#232a33")
		t.TextMuted = ui.Hex("#606b77")
		t.Border = ui.Hex("#dce1e5")
		t.Accent = ui.Hex("#486b1c")
		t.AccentHover = ui.Hex("#355213")
		t.AccentPressed = ui.Hex("#2c4815")
		t.AccentText = ui.Hex("#ffffff")
		t.Warning = ui.Hex("#8b6013")
		t.Danger = ui.Hex("#b74248")
		t.Success = ui.Hex("#2d713e")
		t.Selection = ui.Hex("#edf4e1")
		t.Scrollbar = ui.Hex("#b6bec7")
	}
	t.Focus = t.Accent
	t.Radius = 6
	t.Spacing = 4
	t.FontSize = 14
	return t
}
