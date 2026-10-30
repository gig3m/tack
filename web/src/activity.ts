import type { Activity } from './api.ts';

/** Human sentence for an activity entry. `withCard` names the card (board feed) or not (card feed). */
export function describeActivity(a: Activity, withCard: boolean): string {
  const d = a.data as Record<string, string | number | null>;
  const card = withCard && a.card_title ? ` "${a.card_title}"` : withCard ? ' a card' : ' this card';
  switch (a.type) {
    case 'board.created': return 'created this board';
    case 'board.updated': return 'updated board settings';
    case 'board.archived': return 'archived this board';
    case 'board.restored': return 'restored this board';
    case 'member.added': return `added ${d.name} as ${d.role}`;
    case 'member.role': return `changed a member's role to ${d.role}`;
    case 'member.removed': return 'removed a member';
    case 'list.created': return `added list "${d.name}"`;
    case 'list.renamed': return `renamed list "${d.from}" to "${d.name}"`;
    case 'list.archived': return `archived list "${d.name}"`;
    case 'list.restored': return `restored list "${d.name}"`;
    case 'list.moved': return `moved list "${d.name}"`;
    case 'list.deleted': return `deleted list "${d.name}"`;
    case 'label.created': return 'created a label';
    case 'label.updated': return 'edited a label';
    case 'label.deleted': return 'deleted a label';
    case 'card.created': return withCard ? `added${card} to ${d.list}` : `created this card in ${d.list}`;
    case 'card.renamed': return `renamed${card} from "${d.from}"`;
    case 'card.description': return `updated the description of${card}`;
    case 'card.due': return d.due_at ? `set the due date on${card}` : `removed the due date from${card}`;
    case 'card.due_done': return `marked the due date complete on${card}`;
    case 'card.due_undone': return `marked the due date incomplete on${card}`;
    case 'card.moved': return `moved${card} from ${d.from} to ${d.to}`;
    case 'card.moved_in': return `moved${card} here from another board`;
    case 'card.moved_out': return `moved "${d.title}" to another board`;
    case 'card.archived': return `archived${card}`;
    case 'card.restored': return `restored${card}`;
    case 'card.deleted': return `deleted card "${d.title}"`;
    case 'card.labels': return `changed labels on${card}`;
    case 'card.assigned': return `assigned ${d.name} to${card}`;
    case 'card.unassigned': return `unassigned ${d.name} from${card}`;
    case 'comment.added': return `commented on${card}: “${String(d.excerpt ?? '').slice(0, 80)}”`;
    case 'comment.deleted': return `deleted a comment on${card}`;
    case 'checklist.created': return `added checklist "${d.title}" to${card}`;
    case 'checklist.deleted': return `removed checklist "${d.title}" from${card}`;
    case 'checklist.item_done': return `completed "${d.text}" on${card}`;
    case 'checklist.item_undone': return `unchecked "${d.text}" on${card}`;
    case 'attachment.added': return `attached ${d.filename} to${card}`;
    case 'attachment.deleted': return `removed attachment ${d.filename} from${card}`;
    default: return a.type;
  }
}
