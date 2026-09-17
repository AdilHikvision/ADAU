interface ToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    size?: 'sm' | 'md';
    disabled?: boolean;
    /** Доступное имя переключателя, когда рядом нет связанного <label>. */
    'aria-label'?: string;
    className?: string;
}

/**
 * Переключатель вкл/выкл.
 *
 * Бегунок позиционируется от явного `left`, а не от статической позиции: у <button>
 * по умолчанию `text-align:center`, поэтому абсолютный span без `left` вставал по
 * центру дорожки, и включённое состояние было не отличить от выключенного.
 */
export function Toggle({
    checked,
    onChange,
    size = 'md',
    disabled = false,
    'aria-label': ariaLabel,
    className = '',
}: ToggleProps) {
    // Дорожка, бегунок и сдвиг во включённом состоянии: track − 2·inset − knob.
    const s = size === 'sm'
        ? { track: 'w-10 h-5', knob: 'w-4 h-4 top-0.5 left-0.5', on: 'translate-x-5' }
        : { track: 'w-12 h-6', knob: 'w-5 h-5 top-0.5 left-0.5', on: 'translate-x-6' };

    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`relative shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50 disabled:cursor-not-allowed ${s.track} ${checked ? 'bg-primary' : 'bg-slate-300'} ${className}`}
        >
            {/* Тень — инлайном: страницы со scoped-рестайлом (напр. .stg-page) перебивают
                классы shadow/shadow-sm своей «карточной» тенью через !important. */}
            <span
                style={{ boxShadow: '0 1px 2px rgba(37, 38, 65, .28)' }}
                className={`absolute rounded-full bg-white transition-transform ${s.knob} ${checked ? s.on : 'translate-x-0'}`}
            />
        </button>
    );
}
