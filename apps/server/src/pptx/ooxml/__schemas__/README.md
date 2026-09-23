# OOXML schemas (test fixtures)

The XML Schemas the PPTX exporter's output is validated against in
`../validate.test.ts`. Only the files the PresentationML, DrawingML and
package parts need are kept here, unmodified apart from line endings
(the Ecma files ship with CRLF; git stores them with LF).

| Directory                  | Source                                                                                                                                                                    | Files                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `ecma-376-4-transitional/` | [ECMA-376 Part 4, 5th edition (December 2016)](https://ecma-international.org/publications-and-standards/standards/ecma-376/), `OfficeOpenXML-XMLSchema-Transitional.zip` | PresentationML, DrawingML and shared types                |
| `ecma-376-2-opc/`          | [ECMA-376 Part 2, 5th edition (December 2021)](https://ecma-international.org/publications-and-standards/standards/ecma-376/), `OpenPackagingConventions-XMLSchema.zip`   | `[Content_Types].xml`, relationships, core properties     |
| `dublin-core/`             | [DCMI 2003-04-02 qualified DC schemas](https://www.dublincore.org/schemas/xmls/qdc/2003/04/02/)                                                                           | imported by `opc-coreProperties.xsd`                      |
| `w3c/`                     | [W3C `xml.xsd`](https://www.w3.org/2001/xml.xsd)                                                                                                                          | the `xml:` namespace, imported by the Dublin Core schemas |

Why the Transitional schemas: Narrative writes the transitional namespaces
(`http://schemas.openxmlformats.org/...`), which is what PowerPoint writes
and reads by default.

`catalog.xml` maps the remote locations the OPC and Dublin Core schemas
import to these copies, so validation needs no network.

Ecma standards are freely available and may be copied for implementation
purposes; the Dublin Core schemas are published by DCMI under
[CC BY 4.0](https://www.dublincore.org/about/copyright/); `xml.xsd` is
published by the W3C under the
[W3C Software and Document License](https://www.w3.org/copyright/software-license/).
