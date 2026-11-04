// Package domain defines the versioned HTTP contract independently of storage and UI.
package domain

import "encoding/json"

const SchemaVersion = 1

type Event struct {
	SchemaVersion int             `json:"schemaVersion"`
	EventID       string          `json:"eventId"`
	SourceID      string          `json:"sourceId"`
	Harness       string          `json:"harness"`
	RecordedAt    string          `json:"recordedAt"`
	Native        json.RawMessage `json:"native"`
}

type IngestRequest struct {
	Events []Event `json:"events"`
}
type Acknowledgement struct {
	Accepted   []string `json:"accepted"`
	Duplicates []string `json:"duplicates"`
}

type Source struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Hostname       string            `json:"hostname"`
	Platform       string            `json:"platform"`
	Labels         map[string]string `json:"labels"`
	Status         string            `json:"status"`
	LastSeenAt     *string           `json:"lastSeenAt"`
	LastEventAt    *string           `json:"lastEventAt"`
	PendingEvents  int64             `json:"pendingEvents"`
	RejectedEvents int64             `json:"rejectedEvents"`
	LastError      string            `json:"lastError"`
}
type SourceRequest struct {
	Name     string            `json:"name"`
	Hostname string            `json:"hostname"`
	Platform string            `json:"platform"`
	Labels   map[string]string `json:"labels"`
}
type SourceCredentials struct {
	Source Source `json:"source"`
	Token  string `json:"token"`
}
type SourceList struct {
	Data []Source `json:"data"`
}
type Heartbeat struct {
	SourceID       string            `json:"sourceId"`
	Hostname       string            `json:"hostname"`
	Platform       string            `json:"platform"`
	Labels         map[string]string `json:"labels"`
	PendingEvents  int64             `json:"pendingEvents"`
	RejectedEvents int64             `json:"rejectedEvents"`
	LastError      string            `json:"lastError"`
}

type Harness struct {
	ID               string            `json:"id"`
	Label            string            `json:"label"`
	APIVersions      []string          `json:"apiVersions"`
	OutcomeSemantics map[string]string `json:"outcomeSemantics"`
}
type HarnessList struct {
	Data []Harness `json:"data"`
}

type CallSummary struct {
	ID                string                     `json:"id"`
	SourceID          string                     `json:"sourceId"`
	Harness           string                     `json:"harness"`
	HarnessAPIVersion *string                    `json:"harnessApiVersion"`
	Tool              string                     `json:"tool"`
	ObservedAt        string                     `json:"observedAt"`
	StartedAt         *string                    `json:"startedAt"`
	FinishedAt        *string                    `json:"finishedAt"`
	Lifecycle         string                     `json:"lifecycle"`
	Outcome           string                     `json:"outcome"`
	DurationMs        *float64                   `json:"durationMs"`
	SessionID         *string                    `json:"sessionId"`
	AgentID           *string                    `json:"agentId"`
	Directory         *string                    `json:"directory"`
	Repository        *string                    `json:"repository"`
	InputSummary      string                     `json:"inputSummary"`
	Attributes        map[string]json.RawMessage `json:"attributes"`
}
type NativeDetail struct {
	Attributes map[string]json.RawMessage `json:"attributes"`
	Events     []json.RawMessage          `json:"events"`
}
type CallDetail struct {
	Summary CallSummary     `json:"summary"`
	Input   json.RawMessage `json:"input"`
	Output  json.RawMessage `json:"output"`
	Native  NativeDetail    `json:"native"`
}
type Page struct {
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}
type CallPage struct {
	Data []CallSummary `json:"data"`
	Page Page          `json:"page"`
}
type FacetBucket struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Count int64  `json:"count"`
}
type FacetData struct {
	Tools        []FacetBucket `json:"tools"`
	Sessions     []FacetBucket `json:"sessions"`
	Agents       []FacetBucket `json:"agents"`
	Repositories []FacetBucket `json:"repositories"`
	Directories  []FacetBucket `json:"directories"`
	Lifecycles   []FacetBucket `json:"lifecycles"`
	Outcomes     []FacetBucket `json:"outcomes"`
}
type Facets struct {
	Data FacetData `json:"data"`
}
type ActivityBucket struct {
	Start     string           `json:"start"`
	Count     int64            `json:"count"`
	Harnesses map[string]int64 `json:"harnesses"`
}
type ToolUsage struct {
	Tool  string `json:"tool"`
	Count int64  `json:"count"`
}
type TimeWindow struct {
	Since *string `json:"since"`
	Until *string `json:"until"`
}
type MetricData struct {
	TotalCalls        int64            `json:"totalCalls"`
	CompletedCalls    int64            `json:"completedCalls"`
	AwaitingCalls     int64            `json:"awaitingCalls"`
	SuccessCalls      int64            `json:"successCalls"`
	FailureCalls      int64            `json:"failureCalls"`
	UnknownCalls      int64            `json:"unknownCalls"`
	AverageDurationMs *float64         `json:"averageDurationMs"`
	FailureRate       *float64         `json:"failureRate"`
	Window            TimeWindow       `json:"window"`
	Activity          []ActivityBucket `json:"activity"`
	ToolUsage         []ToolUsage      `json:"toolUsage"`
}
type Metrics struct {
	Data MetricData `json:"data"`
}
type Problem struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Detail string `json:"detail,omitempty"`
}
