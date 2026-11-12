import { FileType } from "@/lib/types";
import {
  FileText,
  Image as ImageIcon,
  Video,
  Music,
  File,
  Archive,
  FileCode,
} from "lucide-react";
import type { LucideProps } from "lucide-react";
import type { FC } from "react";

interface FileIconProps extends LucideProps {
  type: FileType | string;
}

const FileIcon: FC<FileIconProps> = ({ type, ...props }) => {
  const normalizedType = String(type).toLowerCase();
  switch (normalizedType) {
    case "image":
      return <ImageIcon {...props} />;
    case "document":
      return <FileText {...props} />;
    case "video":
      return <Video {...props} />;
    case "audio":
      return <Music {...props} />;
    case "archive":
      return <Archive {...props} />;
    case "code":
      return <FileCode {...props} />;
    default:
      return <File {...props} />;
  }
};

export default FileIcon;
