import { Card, PageHeader } from "@/components/ui";
import { PushSettings } from "@/components/PushSettings";
import { StakeSettings } from "@/components/StakeSettings";

export const metadata = { title: "About · Dissent" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-slate-200">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-slate-400">{children}</div>
    </section>
  );
}

export default function AboutPage() {
  return (
    <>
      <PageHeader
        title="About"
        subtitle="What this measures, and what it refuses to claim."
      />

      <Card className="mb-4 px-3 py-3">
        <StakeSettings />
      </Card>

      <Card className="mb-6 px-3 py-3">
        <PushSettings />
      </Card>

      <Section title="What Move Strength is">
        <p>
          A 0&ndash;99 score for how <em>unusual</em> a line move is, relative to the size
          of move that is normal for that market. It is an ordering device so the biggest
          moves sort to the top.
        </p>
        <p>
          It is <span className="font-medium text-slate-300">not</span> a probability that
          a bet wins. It cannot be, because nothing here has established what a fair price
          is. It is capped at 99 rather than 100 because nothing is certain.
        </p>
      </Section>

      <Section title="Why there are no recommended bets">
        <p>
          The data source exposes exactly one sportsbook. Calling a price good requires
          comparing it to something &mdash; another book, or a model with a demonstrated
          edge. With one book there is nothing to compare against, so any &ldquo;+EV&rdquo;
          label would be invented.
        </p>
        <p>
          That can change. Once enough alerts have been graded against finished games,
          Move Strength can be calibrated into a real probability for the buckets that
          have earned one, and expected value follows from there. Until then the app
          shows movement, not advice.
        </p>
      </Section>

      <Section title="How alerts get scored">
        <p>
          Every alert records which side it expects money to be on, and the line available
          at that moment. Once the game finishes it is graded on two separate questions:
          did the line keep moving that way (line value), and did that side cover
          (result). They are kept apart because good line value with a loss is the
          expected outcome on a small sample, not a contradiction.
        </p>
        <p>
          No rate is published for a slice with fewer than 50 settled games, and pushes
          are excluded rather than counted as losses.
        </p>
      </Section>

      <Section title="The expected outcome">
        <p>
          Line movement in a liquid market is mostly efficient. The most likely finding is
          that these alerts show no durable edge, and the Track Record page is built to
          say so plainly when that is what the numbers show.
        </p>
        <p>
          A tracker that could only ever confirm itself would be worthless. The ability to
          return a negative verdict is what would make a positive one worth acting on.
        </p>
      </Section>

      <Section title="Known limits">
        <ul className="list-disc space-y-1 pl-4">
          <li>One book (DraftKings). No line shopping, no consensus.</li>
          <li>
            The &ldquo;closing&rdquo; number is the last quote observed before kickoff,
            not a verified close.
          </li>
          <li>
            Feed freshness is unmeasured &mdash; timestamps record when we received a
            quote, not when the book changed it.
          </li>
          <li>Settlement rules are unverified; full-game markets only.</li>
        </ul>
      </Section>
    </>
  );
}
