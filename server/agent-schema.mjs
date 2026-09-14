const string = { type: "string" };
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const branch = (tool, args) =>
  obj({ tool: { type: "string", enum: [tool] }, args: obj(args) });
export const AGENT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "rat_agent_action",
    strict: true,
    schema: obj({
      summary: string,
      memory: string,
      action: {
        anyOf: [
          branch("research", { url: string }),
          branch("write_files", {
            files: {
              type: "array",
              items: obj({ name: string, content: string }),
            },
          }),
          branch("read_file", { name: string }),
          branch("list_files", {}),
          branch("run_node", {
            entry: string,
            args: { type: "array", items: string },
          }),
          branch("verify_node", {
            module: string,
            exportName: string,
            cases: {
              type: "array",
              items: obj({
                argsJson: string,
                expectedJson: string,
                throws: { type: "boolean" },
              }),
            },
          }),
          branch("publish_static", {
            slug: string,
            title: string,
            description: string,
          }),
          branch("wait", { seconds: { type: "integer" } }),
        ],
      },
    }),
  },
};
