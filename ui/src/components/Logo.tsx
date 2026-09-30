/**
 * The Track2Mix mark: a mirrored waveform, iris above the baseline and gold
 * below. Kept as a component rather than an <img> so it inherits sizing from
 * className and stays crisp at any density.
 *
 * Geometry is the canonical one in brand/track2mix-mark.svg — if that changes,
 * change it here too.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Track2Mix"
      className={className}
    >
      <rect x="7" y="15.5" width="2.8" height="7" rx="1.4" fill="#7C7EE5" />
      <rect x="7" y="25.5" width="2.8" height="7" rx="1.4" fill="#F5B71C" />
      <rect x="13" y="7.1" width="2.8" height="15.4" rx="1.4" fill="#7C7EE5" />
      <rect x="13" y="25.5" width="2.8" height="15.4" rx="1.4" fill="#F5B71C" />
      <rect x="19" y="12.7" width="2.8" height="9.8" rx="1.4" fill="#7C7EE5" />
      <rect x="19" y="25.5" width="2.8" height="9.8" rx="1.4" fill="#F5B71C" />
      <rect x="25" y="4.3" width="2.8" height="18.2" rx="1.4" fill="#7C7EE5" />
      <rect x="25" y="25.5" width="2.8" height="18.2" rx="1.4" fill="#F5B71C" />
      <rect x="31" y="9.9" width="2.8" height="12.6" rx="1.4" fill="#7C7EE5" />
      <rect x="31" y="25.5" width="2.8" height="12.6" rx="1.4" fill="#F5B71C" />
      <rect x="37" y="15.5" width="2.8" height="7" rx="1.4" fill="#7C7EE5" />
      <rect x="37" y="25.5" width="2.8" height="7" rx="1.4" fill="#F5B71C" />
    </svg>
  );
}
