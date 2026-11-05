package desktop

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
)

const maxPreferences = 64 << 10

// Shell is the entire bound service. Activity and administration use HTTP.
type Shell struct {
	state string
	quit  func()
	mu    sync.Mutex
}

// Preferences returns the new client's settings, or the untouched native seed.
func (s *Shell) Preferences() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, name := range []string{"webview-preferences.json", "native-preferences.json"} {
		data, err := readPreferences(filepath.Join(s.state, name), name == "webview-preferences.json")
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			log.Printf("desktop preferences: %v", err)
			return "{}"
		}
		return string(data)
	}
	return "{}"
}

func readPreferences(path string, private bool) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || private && info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("preferences must be a regular file, private for webview settings")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxPreferences+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxPreferences || !json.Valid(data) {
		return nil, errors.New("preferences exceed 64 KiB or contain invalid JSON")
	}
	return data, nil
}

// SavePreferences atomically writes a private file, never the migration input.
func (s *Shell) SavePreferences(jsonText string) error {
	if len(jsonText) > maxPreferences || !json.Valid([]byte(jsonText)) {
		return errors.New("preferences must be valid JSON no larger than 64 KiB")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.state, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(s.state, ".webview-preferences-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.WriteString(jsonText)
	if writeErr == nil {
		writeErr = f.Sync()
	}
	if err := errors.Join(writeErr, f.Close()); err != nil {
		return fmt.Errorf("save desktop preferences: %w", err)
	}
	return os.Rename(f.Name(), filepath.Join(s.state, "webview-preferences.json"))
}

func (s *Shell) Quit() { s.quit() }
