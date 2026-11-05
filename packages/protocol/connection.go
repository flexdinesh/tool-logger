package domain

// Connection is immutable for one client/window. Credentials never belong in argv.
type Connection struct {
	SchemaVersion int    `json:"schemaVersion"`
	Endpoint      string `json:"endpoint"`
	Token         string `json:"token"`
	Fingerprint   string `json:"fingerprint,omitempty"`
	ServerID      string `json:"serverId"`
}

type ServerStatus struct {
	Ready          bool   `json:"ready"`
	PID            int    `json:"pid"`
	WorkerPID      int    `json:"workerPid"`
	WorkerError    string `json:"workerError,omitempty"`
	ServerID       string `json:"serverId"`
	RemoteEndpoint string `json:"remoteEndpoint,omitempty"`
}

type RemoteRequest struct {
	Listen    string `json:"listen"`
	Advertise string `json:"advertise"`
}

type Invitation struct {
	ConnectionString string `json:"connectionString"`
	Endpoint         string `json:"endpoint"`
	Fingerprint      string `json:"fingerprint"`
	ServerID         string `json:"serverId"`
	ExpiresAt        string `json:"expiresAt"`
}

type PairRequest struct {
	Code string `json:"code"`
}
type LocalSourceRequest struct {
	WorkerPath string `json:"workerPath"`
}
type RemoteClient struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
}
type RemoteClientList struct {
	Data []RemoteClient `json:"data"`
}

type SourceConfig struct {
	SchemaVersion int               `json:"schemaVersion"`
	SourceID      string            `json:"sourceId"`
	Endpoint      string            `json:"endpoint"`
	Token         string            `json:"token"`
	Name          string            `json:"name"`
	Labels        map[string]string `json:"labels"`
}
