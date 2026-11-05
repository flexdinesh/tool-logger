package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"tool-logger/desktop/internal/app"
	"tool-logger/desktop/internal/desktop"
	"tool-logger/desktop/internal/httpapi"
	"tool-logger/desktop/internal/sqlite"
	"tool-logger/desktop/internal/webui"
)

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return runArgs(ctx, os.Args[1:])
}

func runArgs(ctx context.Context, args []string) error {
	if os.Getenv("MYGO_GENERATE") != "" {
		return desktop.GenerateBindings()
	}
	flags := flag.NewFlagSet("tool-logger", flag.ContinueOnError)
	listen := flags.String("listen", envDefault("TOOL_LOGGER_LISTEN", "127.0.0.1:4317"), "HTTP ingestion listener (explicitly choose a private-network address for remote sources)")
	uiListen := flags.String("ui-listen", envDefault("TOOL_LOGGER_UI_LISTEN", "127.0.0.1:4318"), "UI HTTP listener (literal loopback IP only)")
	serve := flags.Bool("serve", false, "run ingestion and browser UI servers without opening a window")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if !*serve && !desktop.AcquireInstance() {
		return nil
	}
	state, err := app.StateDirectory(os.Getenv("TOOL_LOGGER_STATE_DIR"))
	if err != nil {
		return err
	}
	servers, err := startServers(state, *listen, *uiListen)
	if err != nil {
		return err
	}
	defer servers.close()
	log.Printf("Tool Logger ingestion %s; UI %s", servers.endpoint, servers.origin)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	failure := make(chan error, 1)
	go func() {
		select {
		case err := <-servers.errors:
			failure <- err
			cancel()
		case <-ctx.Done():
		}
	}()
	var shellErr error
	if *serve {
		<-ctx.Done()
	} else {
		shellErr = desktop.Run(ctx, servers.origin, state, servers.ui.IssueSession)
	}
	select {
	case err := <-failure:
		return errors.Join(shellErr, err)
	default:
		return shellErr
	}
}

func envDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// runningServers owns all resources, including partial-startup cleanup.
type runningServers struct {
	store            *sqlite.Store
	listeners        []net.Listener
	http             []*http.Server
	ui               *webui.Server
	endpoint, origin string
	errors           chan error
}

func startServers(state, ingestionAddress, uiAddress string) (_ *runningServers, startupErr error) {
	r := &runningServers{errors: make(chan error, 2)}
	defer func() {
		if startupErr != nil {
			r.close()
		}
	}()
	token, err := app.AdminToken(state)
	if err != nil {
		return nil, err
	}
	r.store, err = sqlite.Open(filepath.Join(state, "collector", "events.sqlite"))
	if err != nil {
		return nil, err
	}
	ingestion, err := net.Listen("tcp", ingestionAddress)
	if err != nil {
		return nil, fmt.Errorf("cannot start ingestion listener %s: %w", ingestionAddress, err)
	}
	r.listeners = append(r.listeners, ingestion)
	r.endpoint, err = app.ClientEndpoint(ingestion.Addr())
	if err != nil {
		return nil, err
	}
	ui, err := app.ListenUI(uiAddress)
	if err != nil {
		return nil, fmt.Errorf("cannot start UI listener %s: %w", uiAddress, err)
	}
	r.listeners = append(r.listeners, ui)
	r.origin, err = app.ClientEndpoint(ui.Addr())
	if err != nil {
		return nil, err
	}
	r.ui, err = webui.New(r.endpoint, token, r.origin)
	if err != nil {
		return nil, err
	}
	for i, handler := range []http.Handler{httpapi.New(r.store, token), r.ui.Handler()} {
		server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
		r.http = append(r.http, server)
		listener := r.listeners[i]
		go func() {
			if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				r.errors <- err
			}
		}()
	}
	return r, nil
}

func (r *runningServers) close() {
	// Stop UI proxy work before its backend, and stop HTTP before SQLite.
	for i := len(r.http) - 1; i >= 0; i-- {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := r.http[i].Shutdown(ctx); err != nil {
			log.Printf("HTTP shutdown: %v", err)
			_ = r.http[i].Close()
		}
		cancel()
	}
	for _, listener := range r.listeners {
		_ = listener.Close()
	}
	if r.store != nil {
		if err := r.store.Close(); err != nil {
			log.Printf("SQLite shutdown: %v", err)
		}
	}
}
