import * as React from "react";
import {
  Archive, Atom, Bike, Book, BookOpen, Bookmark, Briefcase, Calendar, Camera, Car, Cloud, Code, Coffee, Compass, Cpu, Database,
  FileText, Film, Flag, FlaskConical, Folder, FolderOpen, GraduationCap, Globe, Hammer, Heart, House, Image, Inbox, Key, Landmark,
  Layers, Leaf, Library, Lightbulb, Link, Lock, Mail, Map as MapIcon, MessageSquare, Microscope, Moon, Music, Newspaper, Package, Palette,
  PenTool, Pin, Plane, Rocket, Server, Shield, Star, Sun, Tag, Terminal, TreePine, User, Users, Utensils, Wrench, Building, Clock,
  type LucideIcon,
} from "lucide-react";

/** The fixed icon set of GET /api/collections/icons (lucide names). Unknown names fall back to a folder. */
const ICONS: Record<string, LucideIcon> = {
  folder: Folder, "folder-open": FolderOpen, star: Star, heart: Heart, bookmark: Bookmark, book: Book, "book-open": BookOpen, library: Library,
  newspaper: Newspaper, "graduation-cap": GraduationCap, "flask-conical": FlaskConical, microscope: Microscope, atom: Atom, globe: Globe,
  map: MapIcon, compass: Compass, landmark: Landmark, building: Building, home: House, briefcase: Briefcase, wrench: Wrench, hammer: Hammer,
  code: Code, terminal: Terminal, cpu: Cpu, database: Database, server: Server, cloud: Cloud, shield: Shield, lock: Lock, key: Key,
  lightbulb: Lightbulb, rocket: Rocket, plane: Plane, car: Car, bike: Bike, utensils: Utensils, coffee: Coffee, leaf: Leaf, "tree-pine": TreePine,
  sun: Sun, moon: Moon, music: Music, film: Film, camera: Camera, image: Image, palette: Palette, "pen-tool": PenTool, "file-text": FileText,
  archive: Archive, inbox: Inbox, tag: Tag, flag: Flag, pin: Pin, clock: Clock, calendar: Calendar, users: Users, user: User,
  "message-square": MessageSquare, mail: Mail, link: Link, layers: Layers, package: Package,
};

export function CollectionIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Folder;
  return <Icon className={className ?? "size-4 shrink-0"} aria-hidden="true" />;
}

export const iconLabel = (name: string) => name.replace(/-/g, " ");
