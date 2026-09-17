import { useTranslation } from 'react-i18next';

/** Логотип ADAU для каждой локализации; незнакомый язык — английский вариант. */
const LOGO_BY_LANG: Record<string, string> = {
    az: '/logos/logo_az.png',
    en: '/logos/logo_en.png',
    ru: '/logos/logo_ru.png',
};

/** Пропорция исходников (1000×~333) — нужна, чтобы зарезервировать ширину до загрузки. */
const ASPECT = 1000 / 333;

interface LogoProps {
    /** Высота знака в px. Ширина считается по пропорции — логотип широкий, примерно 3:1. */
    size?: number;
    className?: string;
    /**
     * Тёмная подложка. Файлы логотипа белые, поэтому на светлых поверхностях
     * (карточка входа, мобильный топбар) он без подложки не виден. В боковом
     * меню фон уже тёмный — там передаём plate={false}.
     */
    plate?: boolean;
}

/**
 * Brand mark — логотип ADAU, свой для az/en/ru.
 * Единственный источник логотипа в приложении (сайдбар, вход, мобильная панель).
 */
export function Logo({ size = 40, className = '', plate = true }: LogoProps) {
    const { i18n } = useTranslation();
    const lang = (i18n.language || 'en').slice(0, 2).toLowerCase();
    const src = LOGO_BY_LANG[lang] ?? LOGO_BY_LANG.en;

    return (
        <span
            className={`inline-flex shrink-0 items-center justify-center ${plate ? 'rounded-xl bg-sidebar px-2.5 py-1.5' : ''} ${className}`}
        >
            <img
                src={src}
                alt="ADAU"
                width={Math.round(size * ASPECT)}
                height={size}
                style={{ height: size, width: 'auto' }}
                className="block max-w-full select-none"
                draggable={false}
            />
        </span>
    );
}
