// Package app composes the observer's filesystem, server and native lifecycle.
package app

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
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

// The native client always uses loopback even when ingestion accepts private-network traffic.
func ClientEndpoint(address net.Addr) (string, error) {
	host, port, err := net.SplitHostPort(address.String())
	if err != nil {
		return "", err
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsUnspecified() {
		if ip.To4() != nil {
			host = "127.0.0.1"
		} else {
			host = "::1"
		}
	}
	if host == "" {
		return "", fmt.Errorf("listener has no host")
	}
	return "http://" + net.JoinHostPort(host, port), nil
}
