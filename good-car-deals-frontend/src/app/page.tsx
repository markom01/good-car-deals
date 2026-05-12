import { DealList } from '@/components';

export default function HomePage() {
  return (
    <main className="container mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Good Car Deals</h1>
      <DealList />
    </main>
  );
}
