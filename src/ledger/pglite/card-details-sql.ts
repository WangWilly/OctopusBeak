/**
 * Card details rows a reader treats as current: of the rows for one
 * transaction revision, the one written by the latest commit, ties broken by
 * the highest record id. The credit-card command writes a details row only
 * when the details changed (ADR 0152), so a revision whose posting date or
 * billing status changed holds several rows, and only the latest is current.
 * Both helpers name the details table `detail`.
 */
const LATEST_FIRST = "detail_commit.commit_sequence DESC, detail.source_record_id DESC";
const WITH_COMMIT = `FROM canonical_credit_card_transaction_details detail
           JOIN source_captures detail_capture ON detail_capture.capture_id = detail.capture_id
           JOIN canonical_commits detail_commit ON detail_commit.commit_id = detail_capture.commit_id`;

/** The current details row of one revision, as a subquery of at most one row; `columns` names fields of `detail`. */
export function latestCardDetailsSql(revisionId: string, columns: string): string {
  return `SELECT ${columns}
           ${WITH_COMMIT}
          WHERE detail.revision_id = ${revisionId}
          ORDER BY ${LATEST_FIRST}
          LIMIT 1`;
}

/** The current details row of every revision `where` admits, one row per revision. */
export function latestCardDetailsByRevisionSql(columns: string, where = "TRUE"): string {
  return `SELECT DISTINCT ON (detail.revision_id) ${columns}
           ${WITH_COMMIT}
          WHERE ${where}
          ORDER BY detail.revision_id, ${LATEST_FIRST}`;
}
