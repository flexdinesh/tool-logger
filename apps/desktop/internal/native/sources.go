package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"
	"tool-logger/desktop/internal/apiclient"
	"tool-logger/desktop/internal/domain"
)

func (m *model) editSource(s domain.Source) {
	m.setupGeneration++
	m.setupBusy = false
	m.showSetup = true
	m.sourceID = s.ID
	m.sourceName = s.Name
	m.sourceHost = s.Hostname
	m.sourcePlatform = s.Platform
	labels := s.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	b, _ := json.MarshalIndent(labels, "", "  ")
	m.sourceLabels = string(b)
	m.credentials = nil
	m.setupError = ""
	m.setupMessage = ""
	m.revokeConfirm = false
}

func (m *model) sourceSetup(c *ui.Context) {
	ui.Column(c).Fill().Padding(16).Gap(12).Children(func() {
		ui.Row(c).Gap(8).Children(func() {
			title := "Add source"
			if m.sourceID != "" {
				title = "Manage source"
			}
			ui.Text(c, title).FontSize(20).Bold().Grow(1)
			if ui.Button(c, "Close setup").Key("close-setup").Clicked() {
				m.showSetup = false
				m.credentials = nil
			}
		})
		ui.Scroll(c.Key("setup-scroll")).Grow(1).Children(func() {
			ui.Column(c).Gap(12).Children(func() {
				ui.Text(c, "Create a source identity for each machine or container. A source token can write only that source's events.").Wrap()
				ui.Text(c, "Name").FontSize(12)
				ui.TextInput(c.Key("source-name"), &m.sourceName).Label("Source name").Placeholder("Workstation")
				ui.Text(c, "Hostname").FontSize(12)
				ui.TextInput(c.Key("source-host"), &m.sourceHost).Label("Source hostname").Placeholder("Optional; heartbeat updates it")
				ui.Text(c, "Platform").FontSize(12)
				ui.TextInput(c.Key("source-platform"), &m.sourcePlatform).Label("Source platform").Placeholder("linux or darwin")
				ui.Text(c, "Labels (JSON object)").FontSize(12)
				ui.TextArea(c.Key("source-labels"), &m.sourceLabels).Height(96).Font("monospace").Label("Source labels")
				if m.setupError != "" {
					ui.Text(c, m.setupError).TextColor(c.Theme().Danger).Selectable().Wrap()
				}
				if m.setupMessage != "" {
					ui.Text(c, m.setupMessage).Selectable().Wrap()
				}
				label := "Create source"
				if m.sourceID != "" {
					label = "Save source"
				}
				if ui.PrimaryButton(c, label).Key("save-source").Disabled(m.setupBusy || strings.TrimSpace(m.sourceName) == "").Clicked() {
					m.saveSource()
				}
				if m.sourceID != "" {
					if ui.Button(c, "Rotate token").Key("rotate-token").Disabled(m.setupBusy).Clicked() {
						m.sourceAction("rotate")
					}
					if !m.revokeConfirm {
						if ui.Button(c, "Revoke token…").Key("revoke-token").Disabled(m.setupBusy).Clicked() {
							m.revokeConfirm = true
						}
					} else {
						ui.Text(c, "Revoke stops delivery for this source. History stays available. Create a new token to reconnect.").Wrap()
						if ui.Button(c, "Confirm revoke").Key("confirm-revoke").Disabled(m.setupBusy).Clicked() {
							m.sourceAction("revoke")
						}
						if ui.Button(c, "Keep token").Key("cancel-revoke").Clicked() {
							m.revokeConfirm = false
						}
					}
				}
				if m.credentials != nil {
					ui.Divider(c)
					ui.Text(c, "Source configuration").Bold()
					ui.Text(c, "Copy now. This token is shown only after creation or rotation. Save as source.json in the source's state directory.").Wrap()
					config := m.sourceConfig()
					ui.TextArea(c.Key("source-config"), &config).Height(200).ReadOnly(true).Font("monospace").FontSize(12).Label("Source configuration JSON")
				}
				ui.Divider(c)
				ui.Text(c, "Connection").Bold()
				ui.Text(c, m.endpoint).FontSize(12).Selectable().Wrap()
				ui.Text(c, "Loopback works locally. For containers use the host gateway; for remote machines use an SSH tunnel or private network endpoint. Tokens authenticate; HTTPS, SSH or VPN encrypts transport.").Wrap()
				if ui.Button(c, "Test connection").Key("test-connection").Disabled(m.setupBusy).Clicked() {
					m.diagnose()
				}
				for _, s := range m.sources {
					if s.ID == m.sourceID {
						ui.Text(c, "Source: "+sourceHealth(s)).Wrap()
						ui.Text(c, "Last heartbeat: "+optional(s.LastSeenAt)).FontSize(12).Wrap()
						ui.Text(c, "Last event: "+optional(s.LastEventAt)).FontSize(12).Wrap()
						if s.LastError != "" {
							ui.Text(c, "Forwarder: "+s.LastError).TextColor(c.Theme().Warning).Selectable().Wrap()
						}
					}
				}
			})
		})
		if m.credentials != nil {
			if ui.PrimaryButton(c, "Copy configuration").Key("copy-source-config").Clicked() {
				c.WriteClipboard(m.sourceConfig())
				m.setupMessage = "Configuration copied"
			}
		}
	})
}

func (m *model) sourceConfig() string {
	if m.credentials == nil {
		return ""
	}
	c := struct {
		SchemaVersion int               `json:"schemaVersion"`
		SourceID      string            `json:"sourceId"`
		Endpoint      string            `json:"endpoint"`
		Token         string            `json:"token"`
		Name          string            `json:"name"`
		Labels        map[string]string `json:"labels"`
	}{1, m.credentials.Source.ID, m.endpoint, m.credentials.Token, m.credentials.Source.Name, m.credentials.Source.Labels}
	if c.Labels == nil {
		c.Labels = map[string]string{}
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return string(b)
}

func (m *model) saveSource() {
	labels := map[string]string{}
	if err := json.Unmarshal([]byte(m.sourceLabels), &labels); err != nil || labels == nil {
		m.setupError = "Labels must be a JSON object with string values."
		return
	}
	v := domain.SourceRequest{Name: strings.TrimSpace(m.sourceName), Hostname: m.sourceHost, Platform: m.sourcePlatform, Labels: labels}
	id := m.sourceID
	generation := m.setupGeneration
	m.setupBusy = true
	m.setupError = ""
	m.setupMessage = ""
	go func() {
		var credentials domain.SourceCredentials
		var source domain.Source
		var err error
		if id == "" {
			credentials, err = m.client.CreateSource(m.closed, v)
			source = credentials.Source
		} else {
			source, err = m.client.UpdateSource(m.closed, id, v)
		}
		m.update(func() {
			if m.setupGeneration != generation {
				return
			}
			m.setupBusy = false
			if m.sourceID != id {
				return
			}
			if err != nil {
				m.setupError = err.Error()
				return
			}
			m.sourceID = source.ID
			m.setupMessage = "Source saved"
			if id == "" {
				m.credentials = &credentials
			} else if m.credentials != nil {
				m.credentials.Source = source
			}
			m.invalidateCollection()
			m.refresh(false)
		})
	}()
}

func (m *model) sourceAction(action string) {
	id := m.sourceID
	generation := m.setupGeneration
	m.setupBusy = true
	m.setupError = ""
	m.credentials = nil
	go func() {
		var credentials domain.SourceCredentials
		var err error
		if action == "rotate" {
			credentials, err = m.client.RotateToken(m.closed, id)
		} else {
			err = m.client.RevokeToken(m.closed, id)
		}
		m.update(func() {
			if m.setupGeneration != generation {
				return
			}
			m.setupBusy = false
			if m.sourceID != id {
				return
			}
			if err != nil {
				m.setupError = err.Error()
				return
			}
			if action == "rotate" {
				m.credentials = &credentials
				m.setupMessage = "Token rotated. Update source.json on this source."
			} else {
				m.setupMessage = "Token revoked. History retained."
				m.revokeConfirm = false
			}
			m.invalidateCollection()
			m.refresh(false)
		})
	}()
}

func (m *model) diagnose() {
	if m.client == nil || m.setupBusy {
		return
	}
	m.setupBusy = true
	m.setupError = ""
	m.setupMessage = "Testing server reachability and administration access…"
	generation := m.setupGeneration
	go func() {
		err := m.client.Health(m.closed)
		message := "Server reachable; administration access accepted."
		if err == nil {
			_, err = m.client.Sources(m.closed)
		}
		if err != nil {
			var problem *apiclient.Error
			if errors.As(err, &problem) && (problem.Problem.Status == 401 || problem.Problem.Status == 403) {
				message = "Server reachable; administration credential rejected. Check the desktop admin credential."
			} else if errors.Is(err, context.DeadlineExceeded) {
				message = "Connection timed out. Check listener, firewall, tunnel and host gateway."
			} else {
				message = fmt.Sprintf("Connection failed: %v. Check endpoint, listener, firewall and SSH/VPN tunnel.", err)
			}
		}
		m.update(func() {
			if m.setupGeneration != generation {
				return
			}
			m.setupBusy = false
			m.setupMessage = message
		})
	}()
}
