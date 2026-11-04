package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"tool-logger/desktop/internal/domain"
	"tool-logger/desktop/internal/httpapi"
	"tool-logger/desktop/internal/sqlite"
)

func TestSharedProtocolFixturesAgainstRealHTTP(t *testing.T) {
	store, err := sqlite.Open(filepath.Join(t.TempDir(), "events.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	server := httptest.NewServer(httpapi.New(store, "synthetic-admin"))
	defer server.Close()
	credentials, err := store.CreateSource(context.Background(), domain.SourceRequest{Name: "Fixture source"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("../../../../packages/protocol/fixtures/events.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Valid   []map[string]json.RawMessage `json:"valid"`
		Invalid []struct {
			Name  string                     `json:"name"`
			Patch map[string]json.RawMessage `json:"patch"`
		} `json:"invalid"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	sourceJSON, _ := json.Marshal(credentials.Source.ID)
	post := func(event map[string]json.RawMessage) int {
		t.Helper()
		body, _ := json.Marshal(map[string]interface{}{"events": []map[string]json.RawMessage{event}})
		request, _ := http.NewRequest("POST", server.URL+"/api/v1/ingest/events", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+credentials.Token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		return response.StatusCode
	}
	for _, fixture := range fixtures.Valid {
		fixture["sourceId"] = sourceJSON
		if code := post(fixture); code != 200 {
			t.Fatalf("valid shared fixture returned %d", code)
		}
	}
	for _, invalid := range fixtures.Invalid {
		t.Run(invalid.Name, func(t *testing.T) {
			event := map[string]json.RawMessage{}
			for key, value := range fixtures.Valid[0] {
				event[key] = value
			}
			for key, value := range invalid.Patch {
				event[key] = value
			}
			if code := post(event); code < 400 || code >= 500 {
				t.Fatalf("invalid shared fixture returned %d", code)
			}
		})
	}
}
