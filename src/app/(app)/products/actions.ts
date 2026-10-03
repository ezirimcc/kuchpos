"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { field, runAction } from "@/server/action";
import {
  addUnit,
  createCategory,
  createProduct,
  removeCategory,
  renameCategory,
  retireUnit,
  setProductActive,
  setUnitPrice,
  setUnitUsage,
  updateProduct,
} from "@/server/business/catalog";

export async function createProductAction(_previous: FormState, formData: FormData): Promise<FormState> {
  let productId = "";
  const result = await runAction({ success: "Product created." }, async (context) => {
    const created = await createProduct(context, {
      name: field(formData, "name"),
      code: field(formData, "code"),
      barcode: field(formData, "barcode"),
      categoryId: field(formData, "categoryId"),
      baseUnitName: field(formData, "baseUnitName"),
      allowsFraction: field(formData, "soldBy") === "measure",
      taxable: field(formData, "taxable"),
      baseForSale: field(formData, "baseForSale"),
      basePrice: field(formData, "basePrice"),
    });
    productId = created.id;
  });
  if (result.status === "success") redirect(`/products/${productId}`);
  return result;
}

export async function updateProductAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Product details saved." }, (context) =>
    updateProduct(context, {
      productId: field(formData, "productId"),
      name: field(formData, "name"),
      code: field(formData, "code"),
      barcode: field(formData, "barcode"),
      categoryId: field(formData, "categoryId"),
      taxable: field(formData, "taxable"),
    }),
  );
}

export async function setProductActiveAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const active = field(formData, "active") === "true";
  return runAction({ success: active ? "Product brought back." : "Product taken out of use." }, (context) =>
    setProductActive(context, { productId: field(formData, "productId"), active }),
  );
}

export async function addUnitAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Unit added." }, (context) =>
    addUnit(context, {
      productId: field(formData, "productId"),
      name: field(formData, "name"),
      factor: field(formData, "factor"),
      forSale: field(formData, "forSale"),
      forPurchase: field(formData, "forPurchase"),
      price: field(formData, "price"),
    }),
  );
}

export async function setUnitPriceAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Price saved." }, (context) =>
    setUnitPrice(context, { unitId: field(formData, "unitId"), price: field(formData, "price") }),
  );
}

export async function setUnitUsageAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Saved." }, (context) =>
    setUnitUsage(context, {
      unitId: field(formData, "unitId"),
      forSale: field(formData, "forSale"),
      forPurchase: field(formData, "forPurchase"),
      price: field(formData, "price"),
    }),
  );
}

export async function retireUnitAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Unit retired." }, (context) =>
    retireUnit(context, { unitId: field(formData, "unitId") }),
  );
}

export async function createCategoryAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Category added." }, (context) =>
    createCategory(context, { name: field(formData, "name") }),
  );
}

export async function renameCategoryAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Category renamed." }, (context) =>
    renameCategory(context, { categoryId: field(formData, "categoryId"), name: field(formData, "name") }),
  );
}

export async function removeCategoryAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Category removed." }, (context) =>
    removeCategory(context, { categoryId: field(formData, "categoryId") }),
  );
}
