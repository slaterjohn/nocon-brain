import { StorageNav } from "@/components/dashboard/storage-nav";

export default function StorageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <StorageNav />
      {children}
    </div>
  );
}
