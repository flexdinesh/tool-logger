// Command tool-logger-desktop owns one native UI connection, never collection.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"tool-logger/apps/desktop/internal/desktop"
	"tool-logger/packages/client"
	"tool-logger/packages/webui"
)

var version = "dev"
var commit = "unknown"
var date = "unknown"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := runArgs(ctx, os.Args[1:]); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func runArgs(ctx context.Context, args []string) error {
	if os.Getenv("MYGO_GENERATE") != "" {
		return desktop.GenerateBindings()
	}
	flags := flag.NewFlagSet("tool-logger-desktop", flag.ContinueOnError)
	connectionPath := flags.String("connection", "", "private connection descriptor path")
	showVersion := flags.Bool("version", false, "print version")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *showVersion {
		fmt.Printf("tool-logger-desktop %s (%s, %s)\n", version, commit, date)
		return nil
	}
	state, err := stateDirectory()
	if err != nil {
		return err
	}
	var connection apiclient.Connection
	if *connectionPath == "" {
		// App bundles contain the matching headless companion. Double-clicking
		// the GUI has the same collector lifecycle as invoking the CLI.
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		if err := startCollectorCompanion(ctx, executable, os.Getenv("TOOL_LOGGER_CLI")); err != nil {
			return err
		}
		connection, err = apiclient.LocalConnection(state)
		if err != nil {
			return err
		}
	} else {
		connection, err = apiclient.LoadConnection(*connectionPath)
		if err != nil {
			return err
		}
	}
	local, localErr := apiclient.LocalConnection(state)
	seedLocal := localErr == nil && local == connection
	viewState, err := desktop.PrepareConnectionState(state, connectionIdentity(connection), seedLocal)
	if err != nil {
		return err
	}
	if !desktop.AcquireInstance(viewState) {
		return nil
	}
	client, err := apiclient.HTTPClient(connection)
	if err != nil {
		return err
	}
	gateway, err := webui.Listen(webui.Config{Endpoint: apiclient.BaseURL(connection), ConnectionEndpoint: connection.Endpoint, Credential: connection.Token, ServerID: connection.ServerID, HTTPClient: client}, "")
	if err != nil {
		client.CloseIdleConnections()
		return err
	}
	defer gateway.Close()
	log.Printf("Tool Logger UI %s", gateway.Origin)
	return desktop.Run(ctx, gateway.Origin, viewState, gateway.UI.IssueSession)
}

func connectionIdentity(connection apiclient.Connection) string {
	// Re-pairing must create a new immutable window, rather than forwarding to
	// an existing window that still holds a revoked credential. Hash before
	// using identity in any native profile or single-instance key.
	key := connection.ServerID + "\x00" + connection.Endpoint + "\x00" + connection.Fingerprint + "\x00" + connection.Token
	hash := sha256.Sum256([]byte(key))
	return hex.EncodeToString(hash[:])
}

// resolveCompanionCLI uses an explicit development binary or the headless CLI
// packaged with this GUI. PATH could select an unrelated installed revision.
func resolveCompanionCLI(executable, override string) (string, error) {
	if override != "" {
		if !filepath.IsAbs(override) {
			return "", errors.New("TOOL_LOGGER_CLI must be an absolute executable path")
		}
		if !executableFile(override) {
			return "", errors.New("TOOL_LOGGER_CLI is not an executable regular file")
		}
		return override, nil
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("resolve desktop executable: %w", err)
	}
	directory := filepath.Dir(resolved)
	for _, candidate := range []string{
		filepath.Join(directory, "tool-logger"),
		filepath.Join(directory, "bin", "tool-logger"),
		filepath.Join(directory, "..", "Resources", "bin", "tool-logger"),
	} {
		if executableFile(candidate) {
			return candidate, nil
		}
	}
	return "", errors.New("headless companion missing; reinstall desktop package or set TOOL_LOGGER_CLI to a matching development CLI")
}

func executableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0
}

func startCollectorCompanion(ctx context.Context, executable, override string) error {
	companion, err := resolveCompanionCLI(executable, override)
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, companion, "server", "start")
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("start collector companion: %w", err)
	}
	return nil
}

func stateDirectory() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.Join(errors.New("resolve state directory"), err)
	}
	if state := os.Getenv("TOOL_LOGGER_STATE_DIR"); state != "" {
		if state == "~" {
			return home, nil
		}
		if strings.HasPrefix(state, "~/") {
			return filepath.Join(home, state[2:]), nil
		}
		return filepath.Abs(state)
	}
	return filepath.Join(home, ".local", "state", "tool-logger"), nil
}
