/**
 * The current card details of one transaction revision, as a subquery of at
 * most one row: the row written by the latest commit. The credit-card command
 * writes a details row only when the details changed (ADR 0152), so a
 * revision whose posting date or billing status changed holds several rows,
 * and only the latest is current. `columns` names fields of `detail`.
 */
export function latestCardDetailsSql(revisionId: string, columns: string): string {
  return `SELECT ${columns}
           FROM canonical_credit_card_transaction_details detail
           JOIN source_captures detail_capture ON detail_capture.capture_id = detail.capture_id
           JOIN canonical_commits detail_commit ON detail_commit.commit_id = detail_capture.commit_id
          WHERE detail.revision_id = ${revisionId}
          ORDER BY detail_commit.commit_sequence DESC, detail.source_record_id
          LIMIT 1`;
}
