import React from "react";

interface AppLogoProps {
  className?: string;
  size?: number;
  showWordmark?: boolean;
}

export const AppLogo: React.FC<AppLogoProps> = ({
  className = "",
  size = 32,
  showWordmark = false,
}) => {
  return (
    <div className={`inline-flex items-center gap-2.5 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0"
      >
        {/* Outer Rounded Black Tile with Sleek Subtle Border */}
        <rect
          x="0.5"
          y="0.5"
          width="39"
          height="39"
          rx="10"
          fill="#000000"
          stroke="#27272A"
          strokeWidth="1"
        />

        {/* Cloud Silhouette in Frosted Translucent White */}
        <path
          d="M28 24.5C29.93 24.5 31.5 22.93 31.5 21C31.5 19.24 30.2 17.78 28.5 17.55C28.1 14.43 25.46 12 22.25 12C20.1 12 18.2 13.08 17.07 14.73C16.4 14.42 15.65 14.25 14.86 14.25C12.32 14.25 10.25 16.27 10.14 18.8C8.09 19.24 6.5 21.05 6.5 23.25C6.5 25.74 8.51 27.75 11 27.75H28C29.93 27.75 31.5 26.18 31.5 24.25H28V24.5Z"
          fill="#FFFFFF"
          fillOpacity="0.25"
        />

        {/* Crisp Solid White Vault Shield */}
        <path
          d="M20 13L26.5 16.5V21.5C26.5 25.5 23.8 28.2 20 29.8C16.2 28.2 13.5 25.5 13.5 21.5V16.5L20 13Z"
          fill="#FFFFFF"
        />

        {/* High-Contrast Black Vault Lock Keyhole */}
        <circle cx="20" cy="20.2" r="2" fill="#000000" />
        <path d="M19 20.8H21V25H19V20.8Z" fill="#000000" />
      </svg>

      {showWordmark && (
        <span className="text-xl font-bold tracking-tight text-white leading-none">
          Cloudvalt
        </span>
      )}
    </div>
  );
};

export default AppLogo;
