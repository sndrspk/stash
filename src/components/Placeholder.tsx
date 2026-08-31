import type { ReactNode } from 'react';

import styles from './Placeholder.module.css';

/**
 * The Phase 1 shell renders these where real screens will go.
 *
 * They name the phase that replaces them on purpose: an empty shell that says what
 * is missing is a working skeleton, whereas mocked-up content is a thing you later
 * have to notice is fake. Delete each one as its phase lands.
 */
export function Placeholder({
  title,
  phase,
  children,
}: {
  title: string;
  phase: string;
  children?: ReactNode;
}) {
  return (
    <section className={styles.wrap}>
      <p className={styles.phase}>{phase}</p>
      <h1 className={styles.title}>{title}</h1>
      {children && <div className={styles.body}>{children}</div>}
    </section>
  );
}
