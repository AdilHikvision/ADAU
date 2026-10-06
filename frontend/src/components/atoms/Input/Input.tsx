import type { ChangeEvent, InputHTMLAttributes } from 'react';
import { DateInput } from '../DateInput';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
    icon?: string;
    containerClassName?: string;
    size?: 'sm' | 'md' | 'lg';
}

export function Input({
    icon,
    className = '',
    containerClassName = '',
    size = 'md',
    ...props
}: InputProps) {
    const sizes = {
        sm: 'h-8 text-[11px]',
        md: 'h-10 text-xs',
        lg: 'h-12 text-sm',
    };

    const fieldClass = `w-full ${sizes[size]} ${icon ? 'pl-10' : 'px-4'} pr-4 bg-slate-75 border border-transparent rounded-xl text-text-dark placeholder:text-text-light/70 focus:ring-2 focus:ring-primary/25 focus:border-primary/40 focus:bg-white outline-none transition-all font-semibold ${className}`;

    // Дата — свой календарь (неделя с понедельника), а не браузерный.
    if (props.type === 'date') {
        return (
            <div className={`relative group ${containerClassName}`}>
                <DateInput
                    value={typeof props.value === 'string' ? props.value : ''}
                    onChange={(e) => props.onChange?.(e as ChangeEvent<HTMLInputElement>)}
                    className={fieldClass}
                    min={typeof props.min === 'string' ? props.min : undefined}
                    max={typeof props.max === 'string' ? props.max : undefined}
                    title={props.title}
                    disabled={props.disabled}
                    required={props.required}
                    id={props.id}
                />
            </div>
        );
    }

    return (
        <div className={`relative group ${containerClassName}`}>
            {icon && (
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-light group-focus-within:text-primary transition-colors text-[18px]">
                    {icon}
                </span>
            )}
            <input
                className={fieldClass}
                {...props}
            />
        </div>
    );
}
