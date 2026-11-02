import { DiscoveryNav } from "@/components/discovery/discovery-nav";

export default function DiscoveryLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <DiscoveryNav />
      {children}
    </div>
  );
}
