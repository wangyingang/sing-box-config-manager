declare const validate: {
  (data: unknown): boolean;
  errors?: { instancePath: string; keyword: string; message?: string }[] | null;
};
export = validate;
