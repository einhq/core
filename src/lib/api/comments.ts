export type CommentEntry = {
  slug: string;
  body: string;
  uid: number;
  author: string;
  /** The person the author's account is linked to (its `person` softlink); absent when it is not linked. */
  personPath?: string;
  createdAt: number;
};
