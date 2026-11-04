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
	"tool-logger/desktop/internal/httpapi"
	"tool-logger/desktop/internal/native"
	"tool-logger/desktop/internal/sqlite"
)

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run() error {
	address := os.Getenv("TOOL_LOGGER_LISTEN")
	if address == "" {
		address = "127.0.0.1:4317"
	}
	listen := flag.String("listen", address, "HTTP ingestion listener (explicitly choose a private-network address for remote sources)")
	serve := flag.Bool("serve", false, "run the same REST backend without opening a window, for diagnostics and integration tests")
	flag.Parse()
	if !*serve && !native.AcquireInstance() {
		return nil
	}
	state, err := app.StateDirectory(os.Getenv("TOOL_LOGGER_STATE_DIR"))
	if err != nil {
		return err
	}
	token, err := app.AdminToken(state)
	if err != nil {
		return err
	}
	store, err := sqlite.Open(filepath.Join(state, "collector", "events.sqlite"))
	if err != nil {
		return err
	}
	defer store.Close()
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return fmt.Errorf("cannot start ingestion listener %s: %w", *listen, err)
	}
	endpoint, err := app.ClientEndpoint(listener.Addr())
	if err != nil {
		listener.Close()
		return err
	}
	server := &http.Server{Handler: httpapi.New(store, token), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	serverErrors := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serverErrors <- err
	}()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("HTTP shutdown: %v", err)
		}
	}()
	log.Printf("Tool Logger HTTP listening at %s; native client %s", listener.Addr(), endpoint)
	if *serve {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		select {
		case <-ctx.Done():
			return nil
		case err := <-serverErrors:
			return err
		}
	}
	return native.Run(endpoint, token)
}
