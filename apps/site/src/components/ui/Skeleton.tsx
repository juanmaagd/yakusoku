/** Loading placeholder block. Pulses (the only motion that means "loading"). */
export default function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded-sm bg-fog ${className}`} />;
}
