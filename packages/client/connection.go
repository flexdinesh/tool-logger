package apiclient

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"tool-logger/packages/protocol"
)

type Connection = domain.Connection

var connectionUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func ValidateConnection(c Connection) error {
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(c.Endpoint, "?#") || c.SchemaVersion != 1 || c.Token == "" || len(c.Token) > 512 || !connectionUUID.MatchString(c.ServerID) {
		return errors.New("invalid connection descriptor")
	}
	for _, char := range []byte(c.Token) {
		if char < 0x21 || char > 0x7e {
			return errors.New("invalid connection credential")
		}
	}
	switch u.Scheme {
	case "unix":
		if u.Host != "" || !filepath.IsAbs(u.Path) || u.Path == "/" || c.Fingerprint != "" {
			return errors.New("invalid Unix connection")
		}
	case "https":
		pin, err := hex.DecodeString(c.Fingerprint)
		if u.Hostname() == "" || (u.Path != "" && u.Path != "/") || len(pin) != sha256.Size || err != nil {
			return errors.New("HTTPS connection requires a SHA-256 certificate fingerprint")
		}
	default:
		return errors.New("connection requires Unix socket or pinned HTTPS")
	}
	return nil
}

func BaseURL(c Connection) string {
	if strings.HasPrefix(c.Endpoint, "unix:") {
		return "http://localhost"
	}
	return strings.TrimRight(c.Endpoint, "/")
}

// HTTPClient pins the leaf certificate before sending HTTP headers or pairing codes.
func HTTPClient(c Connection) (*http.Client, error) {
	if err := ValidateConnection(c); err != nil {
		return nil, err
	}
	transport := &http.Transport{Proxy: nil, ResponseHeaderTimeout: 10 * time.Second, IdleConnTimeout: 30 * time.Second, MaxIdleConns: 8}
	if strings.HasPrefix(c.Endpoint, "unix:") {
		u, _ := url.Parse(c.Endpoint)
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", u.Path)
		}
	} else {
		pin, _ := hex.DecodeString(c.Fingerprint)
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("missing server certificate")
			}
			hash := sha256.Sum256(state.PeerCertificates[0].Raw)
			if subtle.ConstantTimeCompare(hash[:], pin) != 1 {
				return errors.New("server certificate fingerprint mismatch")
			}
			return nil
		}}
	}
	return &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}

func NewConnection(c Connection) (*Client, error) {
	h, err := HTTPClient(c)
	if err != nil {
		return nil, err
	}
	return &Client{base: BaseURL(c), token: c.Token, http: h}, nil
}

func LoadConnection(path string) (Connection, error) {
	var c Connection
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return c, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return c, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 64<<10 {
		return c, errors.New("connection descriptor must be a private regular file")
	}
	d := json.NewDecoder(io.LimitReader(f, 64<<10))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil {
		return c, errors.New("invalid connection descriptor JSON")
	}
	if d.Decode(new(json.RawMessage)) != io.EOF {
		return c, errors.New("trailing connection descriptor data")
	}
	return c, ValidateConnection(c)
}

func LocalConnection(state string) (Connection, error) {
	return LoadConnection(filepath.Join(state, "collector", "connection.json"))
}

func SaveConnection(state string, c Connection) (string, error) {
	if err := ValidateConnection(c); err != nil {
		return "", err
	}
	directory := filepath.Join(state, "connections")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("connection directory must be a real private directory")
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(directory, "connection-*.json")
	if err != nil {
		return "", err
	}
	path := f.Name()
	err = json.NewEncoder(f).Encode(c)
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}

func Pair(ctx context.Context, invitation string) (Connection, error) {
	u, err := url.Parse(invitation)
	if err != nil || u.Scheme != "tool-logger" || u.Host != "pair" || u.Path != "" || u.User != nil || u.Fragment != "" {
		return Connection{}, errors.New("invalid pairing invitation")
	}
	q := u.Query()
	if len(q) != 4 || len(q["endpoint"]) != 1 || len(q["fingerprint"]) != 1 || len(q["serverId"]) != 1 || len(q["code"]) != 1 || q.Get("code") == "" {
		return Connection{}, errors.New("invalid pairing invitation")
	}
	c := Connection{SchemaVersion: 1, Endpoint: q.Get("endpoint"), Fingerprint: q.Get("fingerprint"), ServerID: q.Get("serverId"), Token: "pairing"}
	client, err := NewConnection(c)
	if err != nil {
		return Connection{}, err
	}
	defer client.http.CloseIdleConnections()
	var result Connection
	if err := client.request(ctx, "POST", "/api/v1/pair", nil, domain.PairRequest{Code: q.Get("code")}, &result); err != nil {
		return Connection{}, fmt.Errorf("pairing failed: %w", err)
	}
	if err := ValidateConnection(result); err != nil {
		return Connection{}, err
	}
	if result.Endpoint != c.Endpoint || result.Fingerprint != c.Fingerprint || result.ServerID != c.ServerID {
		return Connection{}, errors.New("pairing server identity differs from invitation")
	}
	return result, nil
}

func (c *Client) Status(ctx context.Context) (r domain.ServerStatus, err error) {
	err = c.request(ctx, "GET", "/api/v1/control/status", nil, nil, &r)
	return
}
func (c *Client) Stop(ctx context.Context) error {
	return c.request(ctx, "POST", "/api/v1/control/stop", nil, nil, nil)
}
func (c *Client) EnableRemote(ctx context.Context, v domain.RemoteRequest) (r domain.Invitation, err error) {
	err = c.request(ctx, "POST", "/api/v1/control/remote", nil, v, &r)
	return
}
func (c *Client) EnsureLocalSource(ctx context.Context, workerPath string) (r domain.SourceConfig, err error) {
	err = c.request(ctx, "POST", "/api/v1/control/local-source", nil, domain.LocalSourceRequest{WorkerPath: workerPath}, &r)
	return
}
func (c *Client) RemoteClients(ctx context.Context) (r domain.RemoteClientList, err error) {
	err = c.request(ctx, "GET", "/api/v1/control/clients", nil, nil, &r)
	return
}
func (c *Client) RevokeClient(ctx context.Context, id string) error {
	return c.request(ctx, "DELETE", "/api/v1/control/clients/"+url.PathEscape(id), nil, nil, nil)
}

// Close releases transport resources owned by this immutable connection.
func (c *Client) Close() { c.http.CloseIdleConnections() }
