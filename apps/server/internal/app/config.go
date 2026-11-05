// Package app owns collector state paths and local administration credentials.
package app

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func StateDirectory(override string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if override == "" {
		return filepath.Join(home, ".local", "state", "tool-logger"), nil
	}
	if override == "~" {
		return home, nil
	}
	if strings.HasPrefix(override, "~/") {
		return filepath.Join(home, override[2:]), nil
	}
	return filepath.Abs(override)
}

// Credentials live outside source.json: an ingestion source never needs admin access.
func AdminToken(state string) (string, error) {
	directory := filepath.Join(state, "collector")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(directory, "admin.token")
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return "", errors.New("administration credential must be a private regular file")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		token := strings.TrimSpace(string(data))
		decoded, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil || len(decoded) != 32 {
			return "", errors.New("invalid administration credential; preserve the file and repair it before starting")
		}
		return token, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(bytes[:])
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	_, writeErr := f.WriteString(token + "\n")
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return "", err
	}
	return token, nil
}
