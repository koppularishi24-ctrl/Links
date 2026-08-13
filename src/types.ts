export interface LinkItem {
  id: string;
  title: string;
  url: string;
  categoryId: string;
  tags: string[];
  notes?: string;
  createdAt: number;
}

export interface Category {
  id: string;
  name: string;
  isExpanded: boolean;
}
