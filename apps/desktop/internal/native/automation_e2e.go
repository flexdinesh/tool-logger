//go:build e2e

package native

// Never linked into ordinary or mygo release builds.
import _ "github.com/egoist/mygo/plugins/automation"
