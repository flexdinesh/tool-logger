package webui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"
	"time"

	"tool-logger/packages/client"
	"tool-logger/packages/protocol"
)

func TestBrowserCapabilitiesExpireAndAreSingleUse(t *testing.T) {
	f := start(t)
	launch, err := url.Parse(f.ui.BrowserURL())
	if err != nil {
		t.Fatal(err)
	}
	capability := strings.TrimPrefix(launch.Fragment, "session=")
	if capability == testAdmin || capability == "" {
		t.Fatal("unsafe browser launch")
	}
	request(t, f, "POST", "/ui/session", `{"token":"`+capability+`"}`, nil, f.server.URL, 204)
	request(t, f, "POST", "/ui/session", `{"token":"`+capability+`"}`, nil, f.server.URL, 401)
	expired, err := url.Parse(f.ui.BrowserURL())
	if err != nil {
		t.Fatal(err)
	}
	f.ui.mu.Lock()
	f.ui.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	f.ui.mu.Unlock()
	request(t, f, "POST", "/ui/session", `{"token":"`+strings.TrimPrefix(expired.Fragment, "session=")+`"}`, nil, f.server.URL, 401)
}

func TestPinnedRemoteGatewayRevocationAndConnectionIsolation(t *testing.T) {
	f, other := start(t), start(t)
	ctx := context.Background()
	if _, err := f.admin.CreateSource(ctx, domain.SourceRequest{Name: "Remote history"}); err != nil {
		t.Fatal(err)
	}
	invitation, err := f.admin.EnableRemote(ctx, domain.RemoteRequest{Listen: "127.0.0.1:0", Advertise: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := apiclient.Pair(ctx, invitation.ConnectionString)
	if err != nil {
		t.Fatal(err)
	}
	transport, err := apiclient.HTTPClient(connection)
	if err != nil {
		t.Fatal(err)
	}
	gateway, err := Listen(Config{Endpoint: apiclient.BaseURL(connection), Credential: connection.Token, ServerID: connection.ServerID, HTTPClient: transport}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	// Use the real listener rather than the fixture's original UI listener.
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	remoteURL, _ := url.Parse(gateway.Origin)
	jar.SetCookies(remoteURL, []*http.Cookie{gateway.UI.IssueSession()})
	otherURL, _ := url.Parse(other.server.URL)
	jar.SetCookies(otherURL, []*http.Cookie{other.ui.IssueSession()})
	if gateway.UI.cookieName == other.ui.cookieName {
		t.Fatal("loopback cookies collide")
	}
	for _, tc := range []struct {
		endpoint string
		present  bool
	}{{gateway.Origin, true}, {other.server.URL, false}, {gateway.Origin, true}} {
		r, err := client.Get(tc.endpoint + "/api/v1/sources")
		if err != nil {
			t.Fatal(err)
		}
		var sources domain.SourceList
		decodeErr := json.NewDecoder(r.Body).Decode(&sources)
		r.Body.Close()
		if r.StatusCode != 200 || decodeErr != nil || (len(sources.Data) == 1) != tc.present {
			t.Fatalf("isolated history %s: %d %+v %v", tc.endpoint, r.StatusCode, sources, decodeErr)
		}
	}
	wrong := connection
	wrong.Fingerprint = strings.Repeat("0", 64)
	badTransport, err := apiclient.HTTPClient(wrong)
	if err != nil {
		t.Fatal(err)
	}
	bad, err := Listen(Config{Endpoint: apiclient.BaseURL(wrong), Credential: wrong.Token, ServerID: wrong.ServerID, HTTPClient: badTransport}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer bad.Close()
	r, _ := http.NewRequest("GET", bad.Origin+"/api/v1/sources", nil)
	r.AddCookie(bad.UI.IssueSession())
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 502 {
		t.Fatal("pin mismatch reached remote API", response.StatusCode)
	}
	clients, err := f.admin.RemoteClients(ctx)
	if err != nil || len(clients.Data) != 1 {
		t.Fatalf("paired clients %+v %v", clients, err)
	}
	if err := f.admin.RevokeClient(ctx, clients.Data[0].ID); err != nil {
		t.Fatal(err)
	}
	response, err = client.Get(gateway.Origin + "/api/v1/sources")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("revoked credential accepted", response.StatusCode)
	}
}

func TestGatewayRejectsUnsafeListenWithoutOpeningListener(t *testing.T) {
	for _, address := range []string{"0.0.0.0:0", "[::]:0", "localhost:0", "127.0.0.1:-1", "127.0.0.1:65536"} {
		if gateway, err := Listen(Config{}, address); err == nil {
			gateway.Close()
			t.Fatal("unsafe listener", address)
		}
	}
}
