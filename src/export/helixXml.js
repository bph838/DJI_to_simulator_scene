// The Heli-X airport file (<scene>.xml). Heli-X uses <ResolutionNNNN> flags to
// know which texture sizes the airport folder provides.

export const ALL_SIZES = [1024, 2048, 4096, 8192];

// Sets the resolution flags in an existing airport XML, adding any that are missing.
export function setResolutions(xml, available) {
  for (const size of ALL_SIZES) {
    const tag = `Resolution${size}`;
    const value = available.includes(size) ? "true" : "false";
    const re = new RegExp(`<${tag}>[^<]*</${tag}>`);
    if (re.test(xml)) {
      xml = xml.replace(re, `<${tag}>${value}</${tag}>`);
    } else {
      xml = xml.replace(/(\s*)<\/project>/, `\n   <${tag}>${value}</${tag}>$1</project>`);
    }
  }
  return xml;
}

// A minimal airport file to start from. Crash objects, start positions and the
// sun direction still need setting up for the real field.
export function newAirportXml({ name, author, comment, available, heightOfEyes = 1.7 }) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const flags = ALL_SIZES.map((s) => `   <Resolution${s}>${available.includes(s)}</Resolution${s}>`).join("\n");
  return `<!-- Heli-X Project File (Format: V5) -->
<project>
   <Version>2024-02-11</Version>
   <Name>${esc(name)}</Name>
   <Author>${esc(author)}</Author>
   <Comment>${esc(comment)}</Comment>
   <StartPosition>0,0,10</StartPosition>
   <StartAngle>0</StartAngle>
   <PlaneStartPosition>0,0,10</PlaneStartPosition>
   <PlaneStartAngle>0</PlaneStartAngle>
   <HeightOfGround>0</HeightOfGround>
${flags}
   <HeightOfEyes>${heightOfEyes}</HeightOfEyes>
</project>
`;
}
