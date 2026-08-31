import { Link } from 'react-router-dom';

import { Placeholder } from '../components/Placeholder';

export function NotFound() {
  return (
    <Placeholder title="Not found" phase="404">
      <p>
        No such page. <Link to="/">Back to the front page</Link>.
      </p>
    </Placeholder>
  );
}
