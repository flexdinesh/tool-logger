// Command tool-logger manages collection and opens an isolated UI connection.
// It has no MyGo dependency and runs on machines without a display.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"tool-logger/apps/server"
	"tool-logger/packages/client"
	"tool-logger/packages/protocol"
	"tool-logger/packages/webui"
)

var version = "dev"
var commit = "unknown"
var date = "unknown"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := runArgs(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func stateDirectory() (string, error) {
	return server.StateDirectory(os.Getenv("TOOL_LOGGER_STATE_DIR"))
}

func runArgs(ctx context.Context, args []string, out, diagnostics io.Writer) error {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "version") {
		_, err := fmt.Fprintf(out, "tool-logger %s (%s, %s)\n", version, commit, date)
		return err
	}
	if len(args) == 1 && (args[0] == "--help" || args[0] == "help") {
		_, err := fmt.Fprintln(out, "tool-logger [--connection path]\n  server start|status|stop|run\n  remote [--listen host:port] [--advertise host:port]\n  connect <invitation>\n  browser [--connection path] [--no-open]\n  plugins install codex|opencode|all [--bundle dir]\n  clients list|revoke <id>\n  --version")
		return err
	}
	state, err := stateDirectory()
	if err != nil {
		return err
	}
	if len(args) > 0 {
		switch args[0] {
		case "server":
			return serverCommand(ctx, state, args[1:], out)
		case "remote":
			return remoteCommand(ctx, state, args[1:], out)
		case "connect":
			if len(args) != 2 {
				return errors.New("usage: tool-logger connect <invitation>")
			}
			connection, err := apiclient.Pair(ctx, args[1])
			if err != nil {
				return err
			}
			path, err := apiclient.SaveConnection(state, connection)
			if err != nil {
				return err
			}
			fmt.Fprintln(out, "Connection saved:", path)
			return openConnection(ctx, state, path, connection, false, false, "", out, diagnostics, nil)
		case "browser":
			return uiCommand(ctx, state, args[1:], true, out, diagnostics)
		case "plugins", "plugin":
			return pluginCommand(ctx, state, args[1:], out, diagnostics)
		case "clients":
			return clientsCommand(ctx, state, args[1:], out)
		}
	}
	return uiCommand(ctx, state, args, false, out, diagnostics)
}

func serverCommand(ctx context.Context, state string, args []string, out io.Writer) error {
	if len(args) != 1 {
		return errors.New("usage: tool-logger server start|status|stop|run")
	}
	switch args[0] {
	case "run":
		return server.Run(ctx, server.Config{State: state})
	case "start":
		if err := server.Ensure(ctx, state); err != nil {
			return err
		}
		fmt.Fprintln(out, "Collector running")
		return nil
	case "stop":
		return server.Stop(ctx, state)
	case "status":
		status, err := server.Status(ctx, state)
		if err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(status)
	default:
		return errors.New("usage: tool-logger server start|status|stop|run")
	}
}

func localClient(ctx context.Context, state string) (*apiclient.Client, error) {
	if err := server.Ensure(ctx, state); err != nil {
		return nil, err
	}
	c, err := apiclient.LocalConnection(state)
	if err != nil {
		return nil, err
	}
	return apiclient.NewConnection(c)
}

func remoteCommand(ctx context.Context, state string, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("remote", flag.ContinueOnError)
	listen := flags.String("listen", "0.0.0.0:4317", "TLS listener")
	advertise := flags.String("advertise", "", "reachable hostname or IP and port; never wildcard")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected remote arguments")
	}
	client, err := localClient(ctx, state)
	if err != nil {
		return err
	}
	defer client.Close()
	invitation, err := client.EnableRemote(ctx, domain.RemoteRequest{Listen: *listen, Advertise: *advertise})
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "tool-logger connect %s\n", shellQuote(invitation.ConnectionString))
	return nil
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func clientsCommand(ctx context.Context, state string, args []string, out io.Writer) error {
	if len(args) == 0 || (args[0] != "list" && args[0] != "revoke") {
		return errors.New("usage: tool-logger clients list|revoke <id>")
	}
	if (args[0] == "list" && len(args) != 1) || (args[0] == "revoke" && len(args) != 2) {
		return errors.New("usage: tool-logger clients list|revoke <id>")
	}
	client, err := localClient(ctx, state)
	if err != nil {
		return err
	}
	defer client.Close()
	if args[0] == "revoke" {
		return client.RevokeClient(ctx, args[1])
	}
	clients, err := client.RemoteClients(ctx)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(clients)
}

func uiCommand(ctx context.Context, state string, args []string, browser bool, out, diagnostics io.Writer) error {
	flags := flag.NewFlagSet("tool-logger", flag.ContinueOnError)
	connectionPath := flags.String("connection", "", "private connection descriptor")
	noOpen := flags.Bool("no-open", false, "print browser URL without opening a browser")
	listen := flags.String("ui-listen", os.Getenv("TOOL_LOGGER_UI_LISTEN"), "UI listener, literal loopback IP only")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *noOpen && !browser {
		return errors.New("--no-open requires browser mode")
	}
	links := flags.Args()
	for _, link := range links {
		if !strings.HasPrefix(link, "tool-logger://activity") {
			return errors.New("unexpected argument: " + link)
		}
	}
	var c apiclient.Connection
	var err error
	if *connectionPath == "" {
		if err := server.Ensure(ctx, state); err != nil {
			return err
		}
		c, err = apiclient.LocalConnection(state)
		if err == nil {
			*connectionPath, err = apiclient.SaveConnection(state, c)
		}
		if err != nil {
			return err
		}
		defer os.Remove(*connectionPath)
	} else {
		c, err = apiclient.LoadConnection(*connectionPath)
		if err != nil {
			return err
		}
	}
	return openConnection(ctx, state, *connectionPath, c, browser, *noOpen, *listen, out, diagnostics, links)
}

func openConnection(ctx context.Context, state, path string, connection apiclient.Connection, browser, noOpen bool, address string, out, diagnostics io.Writer, links []string) error {
	if !browser {
		executable, err := desktopExecutable()
		if err == nil {
			args := append([]string{"--connection", path}, links...)
			command := exec.CommandContext(ctx, executable, args...)
			command.Stdout, command.Stderr = out, diagnostics
			err = command.Run()
			if err == nil || ctx.Err() != nil {
				return nil
			}
		}
		fmt.Fprintln(diagnostics, "Desktop unavailable; opening browser:", err)
	}
	client, err := apiclient.HTTPClient(connection)
	if err != nil {
		return err
	}
	gateway, err := webui.Listen(webui.Config{Endpoint: apiclient.BaseURL(connection), ConnectionEndpoint: connection.Endpoint, Credential: connection.Token, ServerID: connection.ServerID, HTTPClient: client}, address)
	if err != nil {
		client.CloseIdleConnections()
		return err
	}
	defer gateway.Close()
	fmt.Fprintln(diagnostics, "Tool Logger UI", gateway.Origin)
	url := gateway.UI.BrowserURL()
	fmt.Fprintln(out, "Open", url)
	if !noOpen {
		if err := openBrowser(url); err != nil {
			fmt.Fprintln(diagnostics, "Browser launch failed:", err)
		}
	}
	return gateway.Wait(ctx)
}

func desktopExecutable() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	directory := filepath.Dir(executable)
	for _, candidate := range []string{filepath.Join(directory, "tool-logger-desktop"), filepath.Join(directory, "Tool Logger.app", "Contents", "MacOS", "tool-logger-desktop")} {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			return candidate, nil
		}
	}
	return exec.LookPath("tool-logger-desktop")
}

func openBrowser(url string) error {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	command := exec.Command(name, url)
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}

func pluginCommand(ctx context.Context, state string, args []string, out, diagnostics io.Writer) error {
	if len(args) < 2 || args[0] != "install" || (args[1] != "codex" && args[1] != "opencode" && args[1] != "all") {
		return errors.New("usage: tool-logger plugins install codex|opencode|all [--bundle dir]")
	}
	flags := flag.NewFlagSet("plugins install", flag.ContinueOnError)
	bundle := flags.String("bundle", "", "persistent standalone plugin bundle directory")
	if err := flags.Parse(args[2:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected plugin installation arguments")
	}
	if *bundle == "" {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		*bundle = filepath.Join(filepath.Dir(executable), "..", "share", "tool-logger", "plugins")
	}
	directory, err := filepath.Abs(*bundle)
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, "node", filepath.Join(directory, "install.ts"), args[1])
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, out, diagnostics
	if err := command.Run(); err != nil {
		return fmt.Errorf("install plugins: %w", err)
	}
	workerPlugin := "codex-tool-logger"
	if args[1] == "opencode" {
		workerPlugin = "opencode-tool-logger"
	}
	return server.EnsureLocalSource(ctx, state, filepath.Join(directory, "plugins", workerPlugin, "transport", "cli.ts"))
}
