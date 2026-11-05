package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"tool-logger/apps/server/internal/sqlite"
	"tool-logger/packages/protocol"
)

type remoteListener struct {
	request               domain.RemoteRequest
	endpoint, fingerprint string
	server                *http.Server
	listener              net.Listener
}
type certificateFile struct {
	Certificate string `json:"certificate"`
	Key         string `json:"key"`
}

func (c *collector) certificate() (tls.Certificate, string, error) {
	path := filepath.Join(c.state, "collector", "tls.json")
	var file certificateFile
	err := readPrivate(path, &file)
	if errors.Is(err, os.ErrNotExist) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		limit := new(big.Int).Lsh(big.NewInt(1), 128)
		serial, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: c.connection.ServerID}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(10, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		keyDER, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return tls.Certificate{}, "", err
		}
		file = certificateFile{Certificate: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), Key: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))}
		if err := writePrivate(path, file); err != nil {
			return tls.Certificate{}, "", err
		}
	} else if err != nil {
		return tls.Certificate{}, "", err
	}
	cert, err := tls.X509KeyPair([]byte(file.Certificate), []byte(file.Key))
	if err != nil {
		return tls.Certificate{}, "", err
	}
	hash := sha256.Sum256(cert.Certificate[0])
	return cert, hex.EncodeToString(hash[:]), nil
}

// startRemote runs under c.mu after startup. A changed listener invalidates all
// outstanding invitations, while failed activation preserves the prior listener.
func (c *collector) startRemote(request domain.RemoteRequest) (*remoteListener, error) {
	if request.Listen == "" {
		request.Listen = ":4317"
	}
	if c.remote != nil && c.remote.request == request {
		return c.remote, nil
	}
	_, port, err := net.SplitHostPort(request.Listen)
	if err != nil {
		return nil, sqlite.Invalid("listen must be host:port")
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return nil, sqlite.Invalid("listen requires a numeric port")
	}
	// Validate the advertised endpoint before opening or persisting any listener.
	advertise := request.Advertise
	if advertise == "" {
		host, _ := os.Hostname()
		if host == "" {
			return nil, sqlite.Invalid("Specify a reachable advertise host:port")
		}
		advertise = net.JoinHostPort(host, port)
	}
	if strings.HasPrefix(advertise, "https://") {
		u, err := url.Parse(advertise)
		if err != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
			return nil, sqlite.Invalid("advertise must be host:port")
		}
		advertise = u.Host
	}
	host, advertisedPort, err := net.SplitHostPort(advertise)
	if err != nil || host == "" || strings.ContainsAny(host, " /\\?#@%") || host == "*" {
		return nil, sqlite.Invalid("advertise requires a reachable non-wildcard host:port")
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
		return nil, sqlite.Invalid("Cannot advertise a wildcard address")
	}
	if _, err := strconv.ParseUint(advertisedPort, 10, 16); err != nil {
		return nil, sqlite.Invalid("advertise requires a numeric port")
	}
	cert, fingerprint, err := c.certificate()
	if err != nil {
		return nil, err
	}
	var listener net.Listener
	reuse := c.remote != nil && c.remote.request.Listen == request.Listen
	if reuse {
		listener = c.remote.listener
	} else {
		listener, err = net.Listen("tcp", request.Listen)
		if err != nil {
			return nil, sqlite.Invalid("Cannot open requested TLS listener: " + err.Error())
		}
	}
	if advertisedPort == "0" {
		_, advertisedPort, _ = net.SplitHostPort(listener.Addr().String())
	}
	endpoint := "https://" + net.JoinHostPort(host, advertisedPort)
	persisted := request
	if port == "0" {
		persisted.Listen = listener.Addr().String()
	}
	if _, p, _ := net.SplitHostPort(request.Advertise); p == "0" {
		persisted.Advertise = net.JoinHostPort(host, advertisedPort)
	}
	if request.Advertise == "" && port == "0" {
		persisted.Advertise = net.JoinHostPort(host, advertisedPort)
	}
	if strings.HasPrefix(request.Advertise, "https://") {
		persisted.Advertise = endpoint
	}
	if err := writePrivate(filepath.Join(c.state, "collector", "remote.json"), persisted); err != nil {
		if !reuse {
			_ = listener.Close()
		}
		return nil, err
	}
	if reuse {
		c.remote.request = request
		c.remote.endpoint = endpoint
		clear(c.invitations)
		return c.remote, nil
	}
	server := newHTTPServer(c.remoteHandler())
	remote := &remoteListener{request: request, endpoint: endpoint, fingerprint: fingerprint, server: server, listener: listener}
	previous := c.remote
	c.remote = remote
	if previous != nil {
		clear(c.invitations)
		_ = previous.server.Close()
		_ = previous.listener.Close()
	}
	go func() {
		err := server.Serve(tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13}))
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			c.cancel()
		}
	}()
	return remote, nil
}

func (c *collector) closeRemote() {
	c.mu.Lock()
	remote := c.remote
	c.mu.Unlock()
	if remote == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := remote.server.Shutdown(ctx); err != nil {
		_ = remote.server.Close()
	}
	_ = remote.listener.Close()
}

func (c *collector) invite(request domain.RemoteRequest) (domain.Invitation, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	remote, err := c.startRemote(request)
	if err != nil {
		return domain.Invitation{}, err
	}
	for key, expiry := range c.invitations {
		if !time.Now().Before(expiry) {
			delete(c.invitations, key)
		}
	}
	if len(c.invitations) >= 32 {
		return domain.Invitation{}, sqlite.Invalid("Too many outstanding invitations; wait ten minutes")
	}
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return domain.Invitation{}, err
	}
	code := base64.RawURLEncoding.EncodeToString(bytes[:])
	hash := sha256.Sum256([]byte(code))
	expiry := time.Now().Add(10 * time.Minute)
	c.invitations[hex.EncodeToString(hash[:])] = expiry
	invitation := domain.Invitation{Endpoint: remote.endpoint, Fingerprint: remote.fingerprint, ServerID: c.connection.ServerID, ExpiresAt: expiry.UTC().Format(time.RFC3339)}
	q := url.Values{"endpoint": {invitation.Endpoint}, "fingerprint": {invitation.Fingerprint}, "serverId": {invitation.ServerID}, "code": {code}}
	invitation.ConnectionString = (&url.URL{Scheme: "tool-logger", Host: "pair", RawQuery: q.Encode()}).String()
	return invitation, nil
}

func (c *collector) remoteHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path == "/healthz" {
			c.api.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/api/v1/pair" {
			if r.Method != "POST" {
				w.Header().Set("Allow", "POST")
				w.WriteHeader(405)
				return
			}
			var request domain.PairRequest
			if !readRequest(w, r, &request) {
				return
			}
			if len(request.Code) > 128 {
				controlError(w, &sqlite.Error{Status: 401, Title: "Invalid or expired invitation"})
				return
			}
			hash := sha256.Sum256([]byte(request.Code))
			key := hex.EncodeToString(hash[:])
			c.mu.Lock()
			defer c.mu.Unlock()
			expiry, ok := c.invitations[key]
			if !ok || !time.Now().Before(expiry) {
				delete(c.invitations, key)
				controlError(w, &sqlite.Error{Status: 401, Title: "Invalid or expired invitation"})
				return
			}
			_, token, err := c.store.CreateClient(r.Context())
			if err != nil {
				controlError(w, err)
				return
			}
			delete(c.invitations, key)
			writeJSON(w, domain.Connection{SchemaVersion: 1, Endpoint: c.remote.endpoint, Token: token, Fingerprint: c.remote.fingerprint, ServerID: c.connection.ServerID})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/control/") {
			controlError(w, &sqlite.Error{Status: 403, Title: "Local control requires the private Unix socket"})
			return
		}
		// Source tokens retain their existing write-only ingestion boundary.
		if strings.HasPrefix(r.URL.Path, "/api/v1/ingest/") {
			c.api.ServeHTTP(w, r)
			return
		}
		if err := c.store.AuthenticateClient(r.Context(), requestToken(r)); err != nil {
			controlError(w, err)
			return
		}
		request := r.Clone(r.Context())
		request.Header = r.Header.Clone()
		request.Header.Set("Authorization", "Bearer "+c.connection.Token)
		c.api.ServeHTTP(w, request)
	})
}
