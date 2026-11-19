const PLAIN_TEXT_EXTENSIONS = ['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml'];
// Converted through LibreOffice by the document parser; unavailable when it is not installed.
const OFFICE_EXTENSIONS = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'rtf', 'odt', 'ods', 'odp'];
const EXTRACTABLE_EXTENSIONS = new Set([...PLAIN_TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS]);

/** Non-PDF documents whose text the media worker can extract for the agent. */
export function isExtractableDocument(fileName: string): boolean {
    const extension = fileName.toLowerCase().split('.').pop() ?? '';
    return fileName.includes('.') && EXTRACTABLE_EXTENSIONS.has(extension);
}

export const extractedTextPath = (documentPath: string): string => `${documentPath}.extracted.txt`;
