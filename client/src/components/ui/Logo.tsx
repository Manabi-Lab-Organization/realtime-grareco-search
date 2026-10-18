import { PRODUCT_NAME } from 'shared';

interface LogoProps {
  className?: string;
}

export function LogoIcon({ className = 'h-6 w-6' }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 125 125"
      role="img"
      aria-label={PRODUCT_NAME}
      className={className}
    >
      <circle cx="62.5" cy="62.5" r="60" fill="#1B6FB3" />
      <g transform="translate(10 10) scale(0.84)" strokeLinecap="round" fill="none">
        <g stroke="#FFFFFF" strokeWidth="7">
          <line x1="20" y1="54" x2="20" y2="70" />
          <line x1="32" y1="40" x2="32" y2="84" />
          <line x1="44" y1="48" x2="44" y2="76" />
          <line x1="56" y1="56" x2="56" y2="68" />
        </g>
        <circle cx="84" cy="58" r="19" stroke="#FFFFFF" strokeWidth="7" />
        <path d="M72 59 q6 -13 12 0 t12 0" stroke="#F5C04A" strokeWidth="5" />
        <line x1="98" y1="72" x2="108" y2="82" stroke="#FFFFFF" strokeWidth="8" />
      </g>
    </svg>
  );
}
