import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
    fullScreen?: boolean;
    actions?: ReactNode;
    className?: string; // Add className prop
    /** Ширина окна: 'md' — по умолчанию, 'lg'/'xl' — для форм с многоколоночной сеткой. */
    size?: 'md' | 'lg' | 'xl';
    /** Скрыть крестик и запретить закрытие по фону: для окон, которые нельзя
     * закрывать, пока идёт длинная операция (например запись на устройства). */
    hideClose?: boolean;
}

const WIDTH_BY_SIZE: Record<'md' | 'lg' | 'xl', string> = {
    md: 'max-w-lg',
    lg: 'max-w-3xl',
    xl: 'max-w-5xl',
};

export function Modal({ isOpen, onClose, title, children, fullScreen, actions, className = '', size = 'md', hideClose = false }: ModalProps) {
    const { t } = useTranslation();
    if (!isOpen) return null;

    const baseClasses = `relative flex flex-col shadow-float overflow-hidden rounded-2xl border border-border-light animate-pop`;
    const sizeClasses = fullScreen
        ? 'w-[calc(100%-2rem)] h-[calc(100%-2rem)]'
        : `w-full ${WIDTH_BY_SIZE[size]} max-h-[90vh]`;

    const bgClass = className.includes('bg-') ? '' : 'bg-white';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
                className={`absolute inset-0 bg-text-dark/30 backdrop-blur-sm ${hideClose ? '' : 'cursor-pointer'}`}
                onClick={hideClose ? undefined : onClose}
                aria-hidden
            />
            <div
                className={`${baseClasses} ${sizeClasses} ${bgClass} ${className}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="modal-title"
            >
                <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border-light">
                    <h2 id="modal-title" className="text-xl font-bold text-text-dark tracking-tight">
                        {title}
                    </h2>
                    <div className="flex items-center gap-2">
                        {actions}
                        {!hideClose && (
                            <button
                                type="button"
                                onClick={onClose}
                                className="p-1 rounded-lg text-text-muted hover:text-text-dark hover:bg-slate-75 transition-colors"
                                aria-label={t('common.close')}
                            >
                                <span className="material-symbols-outlined text-xl">close</span>
                            </button>
                        )}
                    </div>
                </div>
                <div className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-6`}>{children}</div>
            </div>
        </div>
    );
}
