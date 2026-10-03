export function Spinner({ className = "size-4 border-2" }: { className?: string }) {
  return (
    <span
      className={`inline-block shrink-0 animate-spin rounded-full border-current border-r-transparent ${className}`}
      aria-hidden
    />
  );
}
