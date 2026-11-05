package webui

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strconv"
	"time"
)

// Gateway owns only a loopback UI listener. Closing it never stops collection.
type Gateway struct {
	UI       *Server
	Origin   string
	server   *http.Server
	listener net.Listener
	done     chan error
}

func Listen(config Config, address string) (*Gateway, error) {
	if address == "" {
		address = "127.0.0.1:0"
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("UI listener requires literal loopback IP and port")
	}
	ip := net.ParseIP(host)
	n, portErr := strconv.Atoi(port)
	if ip == nil || !ip.IsLoopback() || portErr != nil || n < 0 || n > 65535 {
		return nil, errors.New("UI listener requires literal loopback IP and port")
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, err
	}
	config.Origin = "http://" + listener.Addr().String()
	ui, err := New(config)
	if err != nil {
		listener.Close()
		return nil, err
	}
	g := &Gateway{UI: ui, Origin: config.Origin, listener: listener, done: make(chan error, 1)}
	g.server = &http.Server{Handler: ui.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: requestTimeout, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		err := g.server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		g.done <- err
	}()
	return g, nil
}

func (g *Gateway) Wait(ctx context.Context) error {
	select {
	case err := <-g.done:
		return err
	case <-ctx.Done():
		return nil
	}
}

func (g *Gateway) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := g.server.Shutdown(ctx)
	if err != nil {
		_ = g.server.Close()
	}
	g.UI.client.CloseIdleConnections()
	g.UI.devClient.CloseIdleConnections()
	return err
}
