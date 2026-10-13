import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Cloud,
  FileText,
  History,
  Link,
  LoaderCircle,
  PanelLeftClose,
  Plus,
  Radio,
  Search,
  Sparkles,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import { position } from './crdt';
import type { Atom } from './crdt';
import { Session } from './session';

type DocumentLink = { id: string; key: string; title: string };
type Revision = { revision: number; author: string; createdAt: string; characters: number };
const readLinks = (): DocumentLink[] => {
  try {
    return JSON.parse(localStorage.getItem('syncspace.links') ?? '[]');
  } catch {
    return [];
  }
};
const colors = ['#8269d6', '#228c85', '#d08b3a', '#cc6589', '#578ccc'];
const colorFor = (id: string) =>
  colors[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % colors.length];
function currentLink(): DocumentLink | null {
  const id = location.pathname.match(/^\/d\/([a-f0-9-]+)$/i)?.[1];
  if (!id) return null;
  const key =
    new URLSearchParams(location.hash.slice(1)).get('key') ??
    readLinks().find((d) => d.id === id)?.key;
  return key
    ? { id, key, title: readLinks().find((d) => d.id === id)?.title ?? 'Shared document' }
    : null;
}
async function request<T>(path: string, doc?: DocumentLink, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(doc ? { Authorization: `Bearer ${doc.key}` } : {}),
      ...options?.headers,
    },
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'This invite link is invalid.'
        : `Request failed (${response.status}). Please try again.`,
    );
  return response.status === 204 ? (undefined as T) : response.json();
}
export function App() {
  const [links, setLinks] = useState(readLinks);
  const [active, setActive] = useState(currentLink);
  const [name, setName] = useState(() => localStorage.getItem('syncspace.name') ?? 'Guest');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [sidebar, setSidebar] = useState(true);
  const remember = (doc: DocumentLink) =>
    setLinks((previous) => {
      const next = [doc, ...previous.filter((d) => d.id !== doc.id)];
      localStorage.setItem('syncspace.links', JSON.stringify(next));
      return next;
    });
  const open = (doc: DocumentLink) => {
    remember(doc);
    history.pushState({}, '', `/d/${doc.id}#key=${doc.key}`);
    setActive(doc);
    setError('');
  };
  useEffect(() => {
    const pop = () => setActive(currentLink());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (active) remember(active);
  }, [active?.id]);
  const create = async () => {
    setCreating(true);
    setError('');
    try {
      open(
        await request<DocumentLink>('/api/documents', undefined, {
          method: 'POST',
          body: JSON.stringify({ title: 'Untitled document' }),
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };
  return (
    <div className={`app ${sidebar ? '' : 'sidebar-hidden'}`}>
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            history.pushState({}, '', '/');
            setActive(null);
          }}
        >
          <span className="brand-icon">
            <Radio size={21} />
          </span>
          SyncSpace<span className="beta">BETA</span>
        </a>
        <div className="workspace-card">
          <span className="workspace-avatar">S</span>
          <div>
            <strong>My workspace</strong>
            <small>A little room for big ideas</small>
          </div>
        </div>
        <button className="new-doc" onClick={create} disabled={creating}>
          {creating ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} New document{' '}
          <span>+</span>
        </button>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search documents"
            placeholder="Find a document..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="section-label">
          YOUR DOCUMENTS <span>{links.length}</span>
        </div>
        <nav className="document-list" aria-label="Documents">
          {links
            .filter((d) => d.title.toLowerCase().includes(search.toLowerCase()))
            .map((doc) => (
              <button
                key={doc.id}
                className={`doc-item ${active?.id === doc.id ? 'active' : ''}`}
                onClick={() => open(doc)}
              >
                <FileText size={16} />
                <span>{doc.title}</span>
                {active?.id === doc.id && <span className="active-dot" />}
              </button>
            ))}
          {!links.length && (
            <p className="sidebar-empty">
              Your next idea starts here.
              <br />
              Create your first document.
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="together-card">
            <span>
              <Users size={19} />
            </span>
            <strong>Better, together.</strong>
            <p>
              Share a link. Bring your team.
              <br />
              Make something great.
            </p>
          </div>
          <label className="profile">
            <span className="profile-avatar">{name.slice(0, 1).toUpperCase()}</span>
            <div>
              <small>EDITING AS</small>
              <input
                aria-label="Your display name"
                value={name}
                maxLength={40}
                onChange={(e) => {
                  setName(e.target.value);
                  localStorage.setItem('syncspace.name', e.target.value);
                }}
              />
            </div>
          </label>
        </div>
      </aside>
      <main className="main">
        {active ? (
          <Editor
            key={active.id}
            doc={active}
            name={name || 'Guest'}
            onTitle={(title) => remember({ ...active, title })}
            toggleSidebar={() => setSidebar(!sidebar)}
          />
        ) : (
          <>
            <header className="topbar">
              <button
                className="icon-button"
                aria-label="Toggle sidebar"
                onClick={() => setSidebar(!sidebar)}
              >
                <PanelLeftClose size={18} />
              </button>
              <span>
                My workspace <ChevronRight size={13} /> Overview
              </span>
              <span className="topbar-right">
                <span className="online-dot" /> A space for your ideas
              </span>
            </header>
            <div className="welcome">
              <span className="eyebrow">
                <Sparkles size={15} /> IDEAS MEET HERE
              </span>
              <h1>
                Good work starts
                <br />
                with a shared space<span>.</span>
              </h1>
              <p>
                A calm place to think, write, and build together.
                <br />
                Your ideas, always in sync.
              </p>
              <button className="primary" onClick={create} disabled={creating}>
                {creating ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} Create
                a document <ArrowUpRight size={16} />
              </button>
              <div className="welcome-preview">
                <div className="preview-top">
                  <span className="preview-dots">● ● ●</span>
                  <span>One page. Endless possibilities.</span>
                  <span className="preview-live">
                    <Radio size={13} /> LIVE
                  </span>
                </div>
                <div className="preview-body">
                  <span className="eyebrow">THE NEXT BIG THING</span>
                  <h2>Let’s put our heads together.</h2>
                  <p>
                    Start with a thought. Add a little perspective.
                    <br />
                    See where it takes you.
                  </p>
                  <div className="sample-line">
                    <span className="sample-cursor" />
                    Every great idea starts with a conversation.
                    <span className="sample-name">Your team</span>
                  </div>
                  <div className="preview-check">
                    <Check size={14} /> Everything saved, automatically
                  </div>
                </div>
              </div>
              <div className="feature-row">
                <span>
                  <Users size={17} /> Write together
                </span>
                <span>
                  <Cloud size={17} /> Saved as you go
                </span>
                <span>
                  <History size={17} /> Every version, kept
                </span>
              </div>
              {links.length > 0 && (
                <div className="recent">
                  <h3>Pick up where you left off</h3>
                  {links.slice(0, 3).map((d) => (
                    <button key={d.id} onClick={() => open(d)}>
                      <FileText size={18} />
                      <span>{d.title}</span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {error && (
          <div className="toast error" role="alert">
            {error}
            <button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error">
              <X size={15} />
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
function Editor({
  doc,
  name,
  onTitle,
  toggleSidebar,
}: {
  doc: DocumentLink;
  name: string;
  onTitle: (title: string) => void;
  toggleSidebar: () => void;
}) {
  const [session] = useState(() => new Session(doc.id, doc.key, name));
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [version, setVersion] = useState<{ revision: number; text: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState(doc.title);
  const editor = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLPreElement>(null);
  const selection = useRef({ anchor: '', head: '' });
  const composing = useRef(false);
  const compositionBase = useRef<Atom[]>([]);
  const [compositionText, setCompositionText] = useState<string | null>(null);
  useEffect(() => {
    void session.start();
    return () => session.dispose();
  }, [session]);
  useEffect(() => {
    session.setName(name);
  }, [session, name]);
  useEffect(() => {
    if (view.ready) {
      setTitle(view.title);
      onTitle(view.title);
    }
  }, [view.title, view.ready]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timeout);
  }, [notice]);
  useLayoutEffect(() => {
    if (editor.current && document.activeElement === editor.current && !composing.current) {
      editor.current.setSelectionRange(
        position(view.nodes, selection.current.anchor),
        position(view.nodes, selection.current.head),
      );
    }
  }, [view.text]);
  const select = () => {
    const element = editor.current;
    if (!element) return;
    session.select(element.selectionStart, element.selectionEnd);
    selection.current = {
      anchor: sessionSelection(element.selectionStart),
      head: sessionSelection(element.selectionEnd),
    };
  };
  const sessionSelection = (offset: number) => {
    // Traverse using the same order as the editor text.
    if (!offset) return '';
    return orderedVisible(session.view.nodes)[offset - 1]?.id ?? '';
  };
  const rename = async () => {
    if (title.trim() === view.title) return;
    try {
      await request(`/api/documents/${doc.id}/title`, doc, {
        method: 'PUT',
        body: JSON.stringify({ title }),
      });
      onTitle(title);
    } catch (e) {
      setNotice(String(e));
      setTitle(view.title);
    }
  };
  const loadHistory = async (more = false) => {
    try {
      const next = await request<Revision[]>(
        `/api/documents/${doc.id}/history${more && revisions.length ? `?before=${revisions.at(-1)!.revision}` : ''}`,
        doc,
      );
      setRevisions((previous) => (more ? [...previous, ...next] : next));
    } catch (e) {
      setNotice(String(e));
    }
  };
  useEffect(() => {
    if (historyOpen) void loadHistory();
  }, [historyOpen, view.revision]);
  const exportText = () => {
    const url = URL.createObjectURL(new Blob([view.text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${view.title.replace(/[^a-z0-9 -]/gi, '') || 'document'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const statusText =
    view.status === 'online'
      ? view.pending
        ? 'Saving changes…'
        : 'All changes saved'
      : view.status === 'connecting'
        ? 'Connecting…'
        : view.status === 'error'
          ? 'Needs attention'
          : 'Offline · saved on this device';
  const cursors = new Map<number, typeof view.peers>();
  for (const peer of view.peers) {
    const offset = position(view.nodes, peer.head);
    cursors.set(offset, [...(cursors.get(offset) ?? []), peer]);
  }
  const renderMirror = () => {
    const elements = [];
    let previous = 0;
    for (const offset of [...cursors.keys()].sort((a, b) => a - b)) {
      elements.push(<span key={`t${offset}`}>{view.text.slice(previous, offset)}</span>);
      for (const peer of cursors.get(offset)!)
        elements.push(
          <span
            key={peer.connectionId}
            className="remote-cursor"
            data-color={colors.indexOf(colorFor(peer.connectionId))}
          >
            <span>{peer.name}</span>
          </span>,
        );
      previous = offset;
    }
    elements.push(
      <span key="tail">
        {view.text.slice(previous)}
        {'\n'}
      </span>,
    );
    return elements;
  };
  return (
    <>
      <header className="topbar">
        <button className="icon-button" aria-label="Toggle sidebar" onClick={toggleSidebar}>
          <PanelLeftClose size={18} />
        </button>
        <span>
          My workspace <ChevronRight size={13} /> <FileText size={14} />
          <span className="breadcrumb-title">{view.title}</span>
        </span>
        <div className="topbar-right">
          <span className={`connection ${view.status}`}>
            {view.status === 'online' ? <span className="online-dot" /> : <WifiOff size={13} />}{' '}
            {view.status === 'online'
              ? 'Live'
              : view.status === 'connecting'
                ? 'Connecting'
                : 'Offline'}
          </span>
          <button
            className={`icon-button ${historyOpen ? 'selected' : ''}`}
            aria-label="Version history"
            title="Version history"
            onClick={() => {
              setHistoryOpen(!historyOpen);
            }}
          >
            <History size={18} />
          </button>
          <button
            className="share-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  `${location.origin}/d/${doc.id}#key=${doc.key}`,
                );
                setNotice('Invite link copied. Anyone with this link can edit.');
              } catch {
                setNotice('Copy the current address to invite someone.');
              }
            }}
          >
            <Link size={15} /> Share
          </button>
        </div>
      </header>
      <div className={`editor-layout ${historyOpen ? 'with-history' : ''}`}>
        <section className="document-area">
          <div className="document-toolbar">
            <span className="document-tag">
              <span /> SHARED DOCUMENT
            </span>
            <div className="collaborators">
              <span className="avatar self" title={`${name} (you)`}>
                {name.slice(0, 1).toUpperCase()}
              </span>
              {view.peers.slice(0, 4).map((p) => (
                <span
                  className={`avatar peer color-${colors.indexOf(colorFor(p.connectionId))}`}
                  key={p.connectionId}
                  title={p.name}
                >
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
              ))}
              <span className="people-count">{view.peers.length + 1} here</span>
            </div>
          </div>
          <input
            className="document-title"
            aria-label="Document title"
            maxLength={100}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <div className="document-meta">
            <span>
              <FileText size={14} /> Plain text
            </span>
            <span>·</span>
            <span>Room for your next idea</span>
            <button
              className="icon-button export"
              aria-label="Export document"
              title="Export text"
              onClick={exportText}
            >
              <ArrowDownToLine size={16} />
            </button>
          </div>
          <div className="editor-paper">
            <pre ref={mirror} className="cursor-mirror" aria-hidden="true">
              {renderMirror()}
            </pre>
            <textarea
              ref={editor}
              aria-label="Document content"
              placeholder={
                'Start writing here…\n\nShare this document to bring your team into the conversation.'
              }
              spellCheck={false}
              disabled={!view.ready}
              value={compositionText ?? view.text}
              onChange={(e) => {
                if (composing.current) {
                  setCompositionText(e.target.value);
                  return;
                }
                session.edit(e.target.value);
                const visible = orderedVisible(session.view.nodes);
                selection.current = {
                  anchor: visible[e.target.selectionStart - 1]?.id ?? '',
                  head: visible[e.target.selectionEnd - 1]?.id ?? '',
                };
              }}
              onSelect={select}
              onCompositionStart={() => {
                composing.current = true;
                compositionBase.current = session.view.nodes;
                setCompositionText(view.text);
              }}
              onCompositionEnd={(e) => {
                composing.current = false;
                session.edit(e.currentTarget.value, compositionBase.current);
                setCompositionText(null);
              }}
              onScroll={(e) => {
                if (mirror.current) {
                  mirror.current.scrollTop = e.currentTarget.scrollTop;
                  mirror.current.scrollLeft = e.currentTarget.scrollLeft;
                }
              }}
            />
          </div>
          <div className="editor-tip">
            <CircleHelp size={14} />
            <span>
              Invite someone with <strong>Share</strong> and watch ideas come together.
            </span>
          </div>
        </section>
        {historyOpen && (
          <aside className="history-panel">
            <div className="history-heading">
              <h3>
                <History size={17} /> Version history
              </h3>
              <button
                className="icon-button"
                aria-label="Close version history"
                onClick={() => {
                  setHistoryOpen(false);
                  setVersion(null);
                }}
              >
                <X size={16} />
              </button>
            </div>
            <p>Every saved edit has a place here.</p>
            {version ? (
              <div className="version-preview">
                <button className="text-button" onClick={() => setVersion(null)}>
                  <ArrowLeft size={14} /> All versions
                </button>
                <h4>Version {version.revision}</h4>
                <pre>{version.text || '(Empty document)'}</pre>
                <button
                  className="primary"
                  disabled={view.status !== 'online' || view.pending > 0}
                  onClick={() => {
                    session.edit(version.text);
                    setVersion(null);
                    setNotice('Version restored as a new edit.');
                  }}
                >
                  Restore this version
                </button>
                <small>Restoring creates a new version and keeps your history.</small>
              </div>
            ) : (
              <div className="revisions">
                {!revisions.length && (
                  <div className="empty-history">
                    <History size={27} />
                    <strong>A fresh start</strong>
                    <span>Start writing to save your first version.</span>
                  </div>
                )}
                {revisions.map((r) => (
                  <button
                    key={r.revision}
                    onClick={async () => {
                      try {
                        setVersion(
                          await request(`/api/documents/${doc.id}/history/${r.revision}`, doc),
                        );
                      } catch (e) {
                        setNotice(String(e));
                      }
                    }}
                  >
                    <span className="revision-dot" />
                    <div>
                      <strong>
                        Version {r.revision}
                        {r.revision === view.revision && <em>Current</em>}
                      </strong>
                      <small>
                        {r.author} ·{' '}
                        {new Date(r.createdAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </small>
                      <small>
                        {new Date(r.createdAt).toLocaleDateString()} · {r.characters} characters
                      </small>
                    </div>
                  </button>
                ))}
                {revisions.length >= 50 && (
                  <button className="text-button" onClick={() => void loadHistory(true)}>
                    Load older versions
                  </button>
                )}
                <button className="text-button" onClick={() => void loadHistory()}>
                  Refresh history
                </button>
              </div>
            )}
          </aside>
        )}
      </div>
      <footer className="statusbar">
        <span className={view.status === 'offline' ? 'offline-status' : ''}>
          {view.status === 'online' && !view.pending ? (
            <Cloud size={14} />
          ) : view.status === 'online' ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <WifiOff size={14} />
          )}{' '}
          {statusText}
        </span>
        <span>
          {view.text.trim() ? view.text.trim().split(/\s+/).length : 0} words{' '}
          <span className="separator">·</span> {view.text.length} characters{' '}
          <span className="separator">·</span> v{view.revision}
        </span>
      </footer>
      {(notice || view.error) && (
        <div className={`toast ${view.error ? 'error' : ''}`} role="status">
          {view.error || notice}
          <button
            className="icon-button"
            onClick={() => setNotice('')}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}
import { ordered as orderedVisible } from './crdt';
