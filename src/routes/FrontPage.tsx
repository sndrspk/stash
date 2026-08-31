import { Placeholder } from '../components/Placeholder';

export function FrontPage() {
  return (
    <Placeholder title="The front page" phase="Phase 5">
      <p>
        A hero, three secondary cards and two sidebar lists — five oldest and five newest unread —
        drawn from the Instapaper unread folder.
      </p>
      <p>Needs the data layer (Phase 3) and resolved images (Phase 4) before it can render.</p>
    </Placeholder>
  );
}
