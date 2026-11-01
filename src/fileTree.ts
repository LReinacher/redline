import type { ChangedFile } from './diff';

export interface FolderNode {
  kind: 'folder';
  /** Repo-relative path of the deepest folder this node stands for. */
  path: string;
  /** Folder name, or several names joined with slashes when single-child folders are compacted. */
  label: string;
  children: TreeNode[];
}

export interface FileNode {
  kind: 'file';
  file: ChangedFile;
}

export type TreeNode = FolderNode | FileNode;

function dirname(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? '' : p.slice(0, slash);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  const name = (n: TreeNode) => (n.kind === 'folder' ? n.label : basename(n.file.path));
  return nodes.sort((a, b) => (a.kind === b.kind ? name(a).localeCompare(name(b)) : a.kind === 'folder' ? -1 : 1));
}

/** Joins chains of folders that only contain one folder, like `apps/api/src`, into one node. */
function compact(folder: FolderNode): FolderNode {
  let node = folder;
  while (node.children.length === 1 && node.children[0].kind === 'folder') {
    const only = node.children[0];
    node = { kind: 'folder', path: only.path, label: `${node.label}/${only.label}`, children: only.children };
  }
  node.children = sortNodes(node.children.map((c) => (c.kind === 'folder' ? compact(c) : c)));
  return node;
}

/** Groups changed files by folder, folders first, with single-child folder chains compacted. */
export function buildTree(files: ChangedFile[]): TreeNode[] {
  const root: FolderNode = { kind: 'folder', path: '', label: '', children: [] };
  const folders = new Map<string, FolderNode>([['', root]]);
  const folderFor = (dir: string): FolderNode => {
    let node = folders.get(dir);
    if (!node) {
      node = { kind: 'folder', path: dir, label: basename(dir), children: [] };
      folderFor(dirname(dir)).children.push(node);
      folders.set(dir, node);
    }
    return node;
  };
  for (const file of files) folderFor(dirname(file.path)).children.push({ kind: 'file', file });
  return sortNodes(root.children.map((c) => (c.kind === 'folder' ? compact(c) : c)));
}

export function filesIn(node: TreeNode): ChangedFile[] {
  return node.kind === 'file' ? [node.file] : node.children.flatMap(filesIn);
}

/** Where a renamed file came from: the old name if it stayed in its folder, else the old path. */
export function movedFrom(file: ChangedFile): string | undefined {
  if (!file.oldPath) return undefined;
  return dirname(file.oldPath) === dirname(file.path) ? basename(file.oldPath) : file.oldPath;
}
