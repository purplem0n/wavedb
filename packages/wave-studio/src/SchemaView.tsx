import { describeDefault, type TableDef } from "./api";

export function SchemaView({ tables, onOpen }: { tables: TableDef[]; onOpen: (name: string) => void }) {
  return (
    <section aria-labelledby="schema-title">
      <header className="view-head">
        <h2 id="schema-title">Schema</h2>
        <p className="muted">{tables.length} table{tables.length === 1 ? "" : "s"}</p>
      </header>
      {tables.length === 0 && <p className="muted">No tables yet. Create one in the SQL console or push a schema with <code>wave push</code>.</p>}
      <div className="cards">
        {tables.map((t) => (
          <article key={t.name} className="card" aria-labelledby={`t-${t.name}`}>
            <h3 id={`t-${t.name}`}>
              <button type="button" className="link" onClick={() => onOpen(t.name)}>
                {t.name}
              </button>
            </h3>
            <table className="grid compact">
              <caption className="sr-only">Columns of {t.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Column</th>
                  <th scope="col">Type</th>
                  <th scope="col">Constraints</th>
                </tr>
              </thead>
              <tbody>
                {t.columns.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.type}</td>
                    <td>
                      {[
                        t.primaryKey.includes(c.name) ? (t.autoIncrement && t.primaryKey[0] === c.name ? "PK autoincrement" : "PK") : "",
                        c.nullable ? "" : "NOT NULL",
                        describeDefault(c.default),
                      ]
                        .filter(Boolean)
                        .join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {t.indexes.length > 0 && (
              <>
                <h4>Indexes</h4>
                <ul>
                  {t.indexes.map((i) => (
                    <li key={i.id}>
                      <code>{i.name}</code> ({i.columns.join(", ")}){i.unique ? " · unique" : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
