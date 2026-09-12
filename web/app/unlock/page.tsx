import { UnlockForm } from "@/components/UnlockForm";

export const metadata = { title: "Dissent" };

export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  // Only same-site paths are accepted as a destination, so the redirect cannot be
  // pointed at another origin by editing the query string.
  const next = from && from.startsWith("/") && !from.startsWith("//") ? from : "/";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6">
      <h1 className="text-[22px] font-semibold tracking-tight text-slate-100">Dissent</h1>
      <p className="mt-1 text-[13px] text-slate-500">
        Enter the passcode to open your board.
      </p>
      <UnlockForm next={next} />
    </main>
  );
}
