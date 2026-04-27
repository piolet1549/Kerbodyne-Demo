import { useEffect, useState } from 'react';
import type { MissionSession, SystemStatusRecord } from '../lib/types';
import { formatTimestamp } from '../lib/time';

interface FlightSavesPanelProps {
  sessions: MissionSession[];
  focusedSessionId?: string | null;
  activeSessionId?: string | null;
  statuses: SystemStatusRecord[];
  onFocusSession: (sessionId: string) => void;
  onUpdateSession: (sessionId: string, name: string, description?: string | null) => void;
  onRequestDeleteSession: (sessionId: string, name: string) => void;
}

function formatStorage(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '<1 KB';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function isErrorStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return normalized.includes('ERROR') || normalized.includes('FAIL');
}

export function FlightSavesPanel({
  sessions,
  focusedSessionId,
  activeSessionId,
  statuses,
  onFocusSession,
  onUpdateSession,
  onRequestDeleteSession
}: FlightSavesPanelProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!editingSessionId) {
      setDraftName('');
      setDraftDescription('');
      return;
    }

    const session = sessions.find((entry) => entry.id === editingSessionId);
    setDraftName(session?.name ?? '');
    setDraftDescription(session?.description ?? '');
  }, [editingSessionId, sessions]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredSessions = normalizedQuery
    ? sessions.filter((session) =>
        [
          session.name,
          session.description ?? '',
          session.started_at,
          formatTimestamp(session.started_at, false)
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery)
      )
    : sessions;

  return (
    <section className="rail-section rail-section--saves">
      <div className="rail-section__header">
        <span className="section-title rail-section__title">Saved Flights</span>
      </div>

      <div className="rail-section__body rail-section__body--with-fade">
        <div className="rail-section__scroll-fade" aria-hidden="true" />
        <div className="save-search-shell">
          <input
            className="save-name-input save-search-input"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search flights"
          />
        </div>

        {filteredSessions.length > 0 ? (
          <div className="save-list">
            {filteredSessions.map((session) => {
              const isFocused = session.id === focusedSessionId;
              const isLive = activeSessionId === session.id;
              const isLocked = Boolean(activeSessionId) && activeSessionId !== session.id;
              const isEditing = editingSessionId === session.id;

              return (
                <article
                  key={session.id}
                  className={`save-row ${isFocused ? 'save-row--selected' : ''}`}
                >
                  <button
                    className="save-row__main"
                    onClick={() => onFocusSession(session.id)}
                    disabled={isLocked}
                  >
                    <div className="save-row__title">
                      <strong>{session.name}</strong>
                      {session.description ? (
                        <p className="save-row__description">{session.description}</p>
                      ) : null}
                      <span className="save-row__footnote">{formatStorage(session.storage_bytes)}</span>
                      {isLive ? <span className="save-badge">Live</span> : null}
                    </div>
                    <span>{formatTimestamp(session.started_at, false)}</span>
                  </button>

                  <div className="save-row__actions">
                    {isEditing ? (
                      <>
                        <input
                          className="save-name-input"
                          value={draftName}
                          onChange={(event) => setDraftName(event.target.value)}
                        />
                        <textarea
                          className="save-name-input save-description-input"
                          value={draftDescription}
                          onChange={(event) => setDraftDescription(event.target.value)}
                          rows={3}
                          placeholder="Optional description"
                        />
                        <button
                          className="secondary-button"
                          onClick={() => {
                            onUpdateSession(session.id, draftName, draftDescription);
                            setEditingSessionId(null);
                          }}
                        >
                          Save
                        </button>
                        <button
                          className="secondary-button secondary-button--muted"
                          onClick={() => setEditingSessionId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="secondary-button secondary-button--muted"
                          onClick={() => setEditingSessionId(session.id)}
                        >
                          Edit
                        </button>
                        <button
                          className="secondary-button secondary-button--danger"
                          onClick={() => onRequestDeleteSession(session.id, session.name)}
                          disabled={isLive}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state empty-state--rail">
            <p>{sessions.length > 0 ? 'No flights match that search' : 'No saved flights yet'}</p>
          </div>
        )}

        {statuses.length > 0 ? (
          <div className="flight-events">
            <span className="section-title section-title--small">Flight events</span>
            <div className="flight-events__list">
              {statuses.slice(0, 4).map((status) => (
                <div key={status.id} className="flight-events__row">
                  <span
                    className={`event-dot ${
                      isErrorStatus(status.status) ? 'event-dot--error' : 'event-dot--ok'
                    }`}
                  />
                  <div>
                    <strong>{status.message}</strong>
                    <span>{formatTimestamp(status.reported_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
