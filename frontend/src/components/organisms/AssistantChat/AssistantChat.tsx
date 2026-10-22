import { useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../auth/AuthContext';
import { apiRequest } from '../../../lib/api';
import { Logo } from '../../atoms';

interface AssistantAction {
    tool: string;
    summary: string;
}

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    actions?: AssistantAction[];
    isError?: boolean;
}

interface AssistantChatResponse {
    reply: string;
    actions: AssistantAction[];
}

interface StoredChat {
    id: string;
    title: string;
    updatedAt: number;
    messages: ChatMessage[];
}

interface ChatStore {
    /** Открытый чат; null — новый, ещё пустой. */
    activeId: string | null;
    /** Отсортированы по updatedAt, первый — последний по времени. */
    chats: StoredChat[];
}

// История живёт в localStorage браузера, отдельно для каждого пользователя.
// Хранилище и список ожидающих ответа вынесены из компонента: панель размонтируется
// при переходе между страницами, а ответ ассистента должен дойти до чата и в этом случае.
const STORAGE_PREFIX = 'projectx.assistant.chats.';
const MAX_CHATS = 30;
const TITLE_LENGTH = 60;

let cached: { key: string; store: ChatStore } | null = null;
const pendingChats = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(listener => listener());
}

function readStore(userKey: string): ChatStore {
    if (cached?.key === userKey) return cached.store;
    let store: ChatStore = { activeId: null, chats: [] };
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + userKey);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<ChatStore>;
            if (Array.isArray(parsed.chats)) store = { activeId: parsed.activeId ?? null, chats: parsed.chats };
        }
    } catch {
        // Повреждённые данные или недоступное хранилище — начинаем с пустой истории.
    }
    cached = { key: userKey, store };
    return store;
}

function commit(userKey: string, mutate: (store: ChatStore) => ChatStore): ChatStore {
    const next = mutate(readStore(userKey));
    const chats = [...next.chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS);
    const store: ChatStore = {
        activeId: chats.some(chat => chat.id === next.activeId) ? next.activeId : null,
        chats,
    };
    cached = { key: userKey, store };
    try {
        localStorage.setItem(STORAGE_PREFIX + userKey, JSON.stringify(store));
    } catch {
        // Хранилище переполнено или запрещено — чат продолжает работать до закрытия вкладки.
    }
    notify();
    return store;
}

function appendMessage(userKey: string, chatId: string, message: ChatMessage) {
    commit(userKey, store => ({
        ...store,
        chats: store.chats.map(chat => chat.id === chatId
            ? { ...chat, updatedAt: Date.now(), messages: [...chat.messages, message] }
            : chat),
    }));
}

function setPending(chatId: string, isPending: boolean) {
    if (isPending) pendingChats.add(chatId);
    else pendingChats.delete(chatId);
    notify();
}

function newChatId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Плавающий ИИ-ассистент: кнопка в правом нижнем углу + панель чата.
 * Команды выполняются на сервере (поиск людей, графики, отчёты) через Claude API.
 */
export function AssistantChat() {
    const { t, i18n } = useTranslation();
    const { token, user, isAuthenticated } = useAuth();

    const [isOpen, setIsOpen] = useState(false);
    const [view, setView] = useState<'chat' | 'history'>('chat');
    const [input, setInput] = useState('');
    const [status, setStatus] = useState<{ enabled: boolean; configured: boolean } | null>(null);
    const [, rerender] = useReducer((n: number) => n + 1, 0);

    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const statusFetchedRef = useRef(false);

    const userKey = user?.id ?? '';
    const store: ChatStore = userKey ? readStore(userKey) : { activeId: null, chats: [] };
    const activeChat = store.chats.find(chat => chat.id === store.activeId) ?? null;
    const lastChat = store.chats[0] ?? null;
    const messages = activeChat?.messages ?? [];
    const isThinking = activeChat !== null && pendingChats.has(activeChat.id);
    const canOpenLastChat = lastChat !== null && (view === 'history' || lastChat.id !== store.activeId);

    useEffect(() => {
        listeners.add(rerender);
        // Чат изменили в другой вкладке — перечитываем хранилище.
        const onStorage = (e: StorageEvent) => {
            if (e.key === null || e.key.startsWith(STORAGE_PREFIX)) {
                cached = null;
                rerender();
            }
        };
        window.addEventListener('storage', onStorage);
        return () => {
            listeners.delete(rerender);
            window.removeEventListener('storage', onStorage);
        };
    }, []);

    useEffect(() => {
        if (!isAuthenticated || !token || statusFetchedRef.current) return;
        statusFetchedRef.current = true;
        apiRequest<{ enabled: boolean; configured: boolean }>('/api/assistant/status', { token })
            .then(setStatus)
            .catch(() => setStatus({ enabled: true, configured: true }));
    }, [isAuthenticated, token]);

    useEffect(() => {
        if (isOpen && view === 'chat') inputRef.current?.focus();
    }, [isOpen, view, store.activeId]);

    useEffect(() => {
        if (view !== 'chat') return;
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages.length, isThinking, isOpen, view, store.activeId]);

    if (!isAuthenticated || !userKey) return null;
    if (status?.enabled === false) return null;

    function openChat(chatId: string | null) {
        commit(userKey, s => ({ ...s, activeId: chatId }));
        setView('chat');
    }

    function deleteChat(chatId: string) {
        commit(userKey, s => ({ ...s, chats: s.chats.filter(chat => chat.id !== chatId) }));
    }

    async function send() {
        const text = input.trim();
        if (!text || isThinking) return;

        const userMessage: ChatMessage = { role: 'user', content: text };
        let chatId = store.activeId ?? '';
        const next = commit(userKey, s => {
            if (!s.chats.some(chat => chat.id === chatId)) {
                chatId = newChatId();
                return {
                    activeId: chatId,
                    chats: [...s.chats, { id: chatId, title: text.slice(0, TITLE_LENGTH), updatedAt: Date.now(), messages: [userMessage] }],
                };
            }
            return {
                activeId: chatId,
                chats: s.chats.map(chat => chat.id === chatId
                    ? { ...chat, updatedAt: Date.now(), messages: [...chat.messages, userMessage] }
                    : chat),
            };
        });
        const history = next.chats.find(chat => chat.id === chatId)?.messages ?? [userMessage];

        setInput('');
        setPending(chatId, true);

        try {
            const response = await apiRequest<AssistantChatResponse>('/api/assistant/chat', {
                method: 'POST',
                token,
                body: JSON.stringify({
                    // Тексты ошибок — не реплики ассистента, модели их не пересылаем.
                    messages: history.filter(m => !m.isError).map(m => ({ role: m.role, content: m.content })),
                }),
            });
            appendMessage(userKey, chatId, {
                role: 'assistant',
                content: response.reply,
                actions: response.actions,
            });
        } catch (error) {
            appendMessage(userKey, chatId, {
                role: 'assistant',
                content: error instanceof Error ? error.message : t('assistant.error'),
                isError: true,
            });
        } finally {
            setPending(chatId, false);
        }
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
        }
    }

    function formatTime(timestamp: number) {
        return new Date(timestamp).toLocaleString(i18n.language, {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    }

    const headerButtonClass = 'flex h-8 w-8 items-center justify-center rounded-lg text-text-light transition-colors hover:bg-slate-75 hover:text-text-dark';

    return (
        <>
            {/* Плавающая кнопка */}
            <button
                type="button"
                onClick={() => setIsOpen(o => !o)}
                title={t('assistant.title')}
                className={`fixed bottom-20 md:bottom-6 right-5 z-40 flex h-13 w-13 items-center justify-center rounded-full text-white shadow-primary transition-all hover:scale-105 active:scale-95 ${isOpen ? 'bg-text-dark' : 'bg-brand-gradient'}`}
            >
                <span className="material-symbols-outlined text-2xl icon-fill">
                    {isOpen ? 'close' : 'auto_awesome'}
                </span>
            </button>

            {/* Панель чата */}
            {isOpen && (
                <div className="animate-pop fixed bottom-36 md:bottom-22 right-5 z-40 flex w-[min(400px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-border-light bg-white shadow-float"
                    style={{ height: 'min(560px, calc(100dvh - 12rem))' }}
                >
                    {/* Шапка */}
                    <div className="flex items-center gap-3 border-b border-border-light bg-slate-75/60 px-4 py-3">
                        <Logo size={32} />
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-extrabold tracking-tight text-text-dark leading-tight">{t('assistant.title')}</p>
                            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-light">{t('assistant.subtitle')}</p>
                        </div>
                        <div className="flex items-center gap-0.5">
                            {canOpenLastChat && (
                                <button
                                    type="button"
                                    onClick={() => openChat(lastChat?.id ?? null)}
                                    title={t('assistant.lastChat')}
                                    className={headerButtonClass}
                                >
                                    <span className="material-symbols-outlined text-[18px]">history</span>
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setView(v => v === 'history' ? 'chat' : 'history')}
                                title={t('assistant.history')}
                                className={`${headerButtonClass} ${view === 'history' ? 'bg-slate-75 text-text-dark' : ''}`}
                            >
                                <span className="material-symbols-outlined text-[18px]">forum</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => openChat(null)}
                                title={t('assistant.newChat')}
                                className={headerButtonClass}
                            >
                                <span className="material-symbols-outlined text-[18px]">add_comment</span>
                            </button>
                        </div>
                    </div>

                    {view === 'history' ? (
                        /* История чатов */
                        <div className="flex-1 space-y-1.5 overflow-y-auto px-3 py-3">
                            {store.chats.length === 0 && (
                                <p className="mt-10 text-center text-sm font-semibold text-text-muted">{t('assistant.historyEmpty')}</p>
                            )}
                            {store.chats.map(chat => (
                                <div
                                    key={chat.id}
                                    className={`group flex items-center gap-1 rounded-xl border px-3 py-2 transition-colors ${chat.id === store.activeId
                                        ? 'border-primary/30 bg-primary/5'
                                        : 'border-border-light bg-slate-75/50 hover:border-primary/30 hover:bg-primary/5'
                                        }`}
                                >
                                    <button type="button" onClick={() => openChat(chat.id)} className="min-w-0 flex-1 text-left">
                                        <p className="truncate text-xs font-bold text-text-dark">{chat.title}</p>
                                        <p className="text-[10px] font-semibold text-text-light">{formatTime(chat.updatedAt)}</p>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => deleteChat(chat.id)}
                                        title={t('assistant.deleteChat')}
                                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-light transition-colors hover:bg-error-bg hover:text-error-text"
                                    >
                                        <span className="material-symbols-outlined text-[16px]">delete</span>
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <>
                            {/* Сообщения */}
                            <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                                {messages.length === 0 && (
                                    <div className="mt-6 space-y-3 text-center">
                                        <span className="material-symbols-outlined text-4xl text-primary/40 icon-fill">auto_awesome</span>
                                        <p className="text-sm font-semibold text-text-muted">{t('assistant.intro')}</p>
                                        {status?.configured === false && (
                                            <p className="text-[11px] font-semibold text-text-light">{t('assistant.notConfigured')}</p>
                                        )}
                                        <div className="space-y-1.5 pt-1">
                                            {[t('assistant.example1'), t('assistant.example2'), t('assistant.example3')].map(example => (
                                                <button
                                                    key={example}
                                                    type="button"
                                                    onClick={() => { setInput(example); inputRef.current?.focus(); }}
                                                    className="block w-full rounded-xl border border-border-light bg-slate-75/50 px-3 py-2 text-left text-xs font-semibold text-text-base transition-colors hover:border-primary/30 hover:bg-primary/5"
                                                >
                                                    {example}
                                                </button>
                                            ))}
                                        </div>
                                        {canOpenLastChat && (
                                            <button
                                                type="button"
                                                onClick={() => openChat(lastChat?.id ?? null)}
                                                className="inline-flex max-w-full items-center gap-1.5 rounded-xl bg-primary/10 px-3 py-2 text-xs font-bold text-primary transition-colors hover:bg-primary/15"
                                            >
                                                <span className="material-symbols-outlined shrink-0 text-[16px]">history</span>
                                                <span className="truncate">{t('assistant.lastChat')}: {lastChat?.title}</span>
                                            </button>
                                        )}
                                    </div>
                                )}

                                {messages.map((message, i) => (
                                    <div key={i} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                        <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${message.role === 'user'
                                            ? 'bg-brand-gradient text-white rounded-br-md'
                                            : message.isError
                                                ? 'bg-error-bg text-error-text rounded-bl-md font-semibold'
                                                : 'bg-slate-75 text-text-dark rounded-bl-md'
                                            }`}
                                        >
                                            {message.content}
                                            {message.actions && message.actions.length > 0 && (
                                                <div className="mt-2 space-y-1 border-t border-border-base/60 pt-2">
                                                    {message.actions.map((action, j) => (
                                                        <div key={j} className="flex items-start gap-1.5 text-[11px] font-semibold text-text-muted">
                                                            <span className="material-symbols-outlined mt-px shrink-0 text-[13px] text-primary">bolt</span>
                                                            <span>{action.summary}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}

                                {isThinking && (
                                    <div className="flex justify-start">
                                        <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-slate-75 px-3.5 py-2.5">
                                            <span className="spinner-ring text-[16px] text-primary" aria-hidden="true" />
                                            <span className="text-xs font-semibold text-text-muted">{t('assistant.thinking')}</span>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Ввод */}
                            <div className="border-t border-border-light p-3">
                                <div className="flex items-center gap-2">
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={input}
                                        onChange={e => setInput(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        placeholder={t('assistant.placeholder')}
                                        disabled={isThinking}
                                        className="h-10 flex-1 rounded-xl border border-transparent bg-slate-75 px-3.5 text-sm font-semibold text-text-dark outline-none transition-all placeholder:text-text-light focus:border-primary/40 focus:bg-white focus:ring-2 focus:ring-primary/25 disabled:opacity-60"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => void send()}
                                        disabled={!input.trim() || isThinking}
                                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-primary transition-all hover:brightness-110 disabled:opacity-40"
                                    >
                                        <span className="material-symbols-outlined text-[20px]">send</span>
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            )}
        </>
    );
}
