package sqlite

import (
	"context"
	"encoding/json"
	"tool-logger/packages/protocol"
)

// ProvisionLocalSource recovers an interrupted filesystem provisioning operation.
// The collector durably records credentials privately before calling this method.
func (s *Store) ProvisionLocalSource(ctx context.Context, config domain.SourceConfig, request domain.SourceRequest) error {
	if !ValidUUID(config.SourceID) || len(config.Token) != 43 {
		return Invalid("Invalid pending local source credentials")
	}
	if err := validateSource(request); err != nil {
		return err
	}
	labels, err := json.Marshal(request.Labels)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO sources(id,name,hostname,platform,labels,token_hash) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, config.SourceID, request.Name, request.Hostname, request.Platform, string(labels), hash(config.Token))
	if err != nil {
		return err
	}
	var tokenHash string
	var revoked int
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(token_hash,''),revoked FROM sources WHERE id=?", config.SourceID).Scan(&tokenHash, &revoked); err != nil {
		return err
	}
	if revoked != 0 || tokenHash != hash(config.Token) {
		return Invalid("Pending local source conflicts with existing identity")
	}
	return tx.Commit()
}

// Remote credentials are independent of the local admin and ingestion tokens.
func (s *Store) CreateClient(ctx context.Context) (string, string, error) {
	t, h, err := token()
	if err != nil {
		return "", "", err
	}
	id := UUID()
	_, err = s.db.ExecContext(ctx, "INSERT INTO remote_clients(id,token_hash,created_at) VALUES(?,?,?)", id, h, now())
	return id, t, err
}
func (s *Store) AuthenticateClient(ctx context.Context, t string) error {
	if t == "" {
		return &Error{Status: 401, Title: "Unauthorized"}
	}
	var id string
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM remote_clients WHERE token_hash=?", hash(t)).Scan(&id); err != nil {
		return &Error{Status: 401, Title: "Unauthorized"}
	}
	return nil
}
func (s *Store) RemoteClients(ctx context.Context) (domain.RemoteClientList, error) {
	result := domain.RemoteClientList{Data: []domain.RemoteClient{}}
	rows, err := s.db.QueryContext(ctx, "SELECT id,created_at FROM remote_clients ORDER BY created_at,id")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var client domain.RemoteClient
		if err := rows.Scan(&client.ID, &client.CreatedAt); err != nil {
			return result, err
		}
		result.Data = append(result.Data, client)
	}
	return result, rows.Err()
}
func (s *Store) RevokeClient(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, "DELETE FROM remote_clients WHERE id=?", id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return missing()
	}
	return nil
}
